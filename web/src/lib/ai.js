export { sanitizeAssistantText } from './sanitizeAssistantText.js';
import { MAX_HISTORY_MESSAGES } from './chatLimits.js';
import { isCooling, quotaMessage } from './quota.js';

export async function checkChatBackend(signal) {
  try {
    const res = await fetch('/api/chat', { method: 'GET', signal });
    if (!res.ok) return { mode: 'off', ready: false, privacy: false, notice: '' };
    const body = await res.json();
    const mode = body?.mode === 'live' || body?.mode === 'canned' ? body.mode : 'off';
    return {
      mode,
      ready: Boolean(body?.ready),
      privacy: Boolean(body?.privacy),
      notice: typeof body?.notice === 'string' ? body.notice : '',
      state: body?.state === 'cooling' || body?.state === 'exhausted' ? body.state : 'ok',
      resetAt: typeof body?.resetAt === 'string' ? body.resetAt : null,
      retryAfterSeconds: Number.isFinite(body?.retryAfterSeconds) ? body.retryAfterSeconds : null,
    };
  } catch {
    if (signal?.aborted) return { mode: 'off', ready: false, privacy: false, notice: '', aborted: true };
    return { mode: 'off', ready: false, privacy: false, notice: '' };
  }
}

export class BothModelsQuotaError extends Error {
  constructor(message = 'model quota reached, try again later') {
    super(message);
    this.name = 'BothModelsQuotaError';
    this.code = 'BOTH_MODELS_QUOTA';
  }
}

export const CHAT_PAUSED = 'Chat is paused in this demo.';

export const CHAT_PRIVACY =
  "In this demo, chat messages and the open clip are sent to Google's Gemini API to generate answers. On the free tier, Google uses the content you submit to the Services and any generated responses to provide, improve, and develop Google products and services and machine learning technologies.";

const PAUSED_STATUS = new Set([401, 402, 403, 429, 500, 502, 503, 504]);
const PAUSED_CODE = new Set(['BOTH_MODELS_QUOTA', 'SPEND_CAP', 'NOT_CONFIGURED', 'API_ERROR']);

/** The model cannot answer. The UI says the demo is paused instead of a raw error. */
export function chatPaused(err) {
  if (!err || err.name === 'AbortError' || err.code === 'ABORTED') return false;
  if (PAUSED_CODE.has(err.code) || err instanceof BothModelsQuotaError) return true;
  const status = Number(err.status);
  if (PAUSED_STATUS.has(status)) return true;
  const text = String(err.message || err || '').toLowerCase();
  if (/\b(401|402|403|429|500|502|503|504)\b/.test(text)) return true;
  return /quota|rate limit|usage limit|spend cap|unavailable|api key/.test(text);
}

export function formatChatError(err) {
  if (err?.scope && (isCooling(err.scope) || err.scope === 'day_quota' || err.scope === 'own_daily_cap' || err.scope === 'auth')) {
    return quotaMessage(err, Date.now(), CHAT_PAUSED);
  }
  if (chatPaused(err)) return CHAT_PAUSED;
  const text = String(err?.message || err || 'unknown error');
  if (err?.code === 'NO_BACKEND' || text.includes('404')) {
    return 'chat backend unreachable. it runs on the deployed site (or locally via `npm run dev` with .env.local).';
  }
  if (err?.code === 'message_too_long') return 'That message is too long.';
  if (err?.code === 'payload_too_large') return 'That request is too large.';
  const clipped = text.replace(/\s+/g, ' ').slice(0, 220);
  return `AI error: ${clipped || 'unknown failure'}`;
}

function aborted() {
  const err = new Error('aborted');
  err.name = 'AbortError';
  err.code = 'ABORTED';
  return err;
}

export async function* streamChatReply({ priorMessages = [], message, focus = null, signal } = {}) {
  if (signal?.aborted) throw aborted();
  const history = priorMessages
    .filter((m) => m?.text && (m.role === 'user' || m.role === 'assistant') && !m.error)
    .slice(-MAX_HISTORY_MESSAGES)
    .map((m) => ({ role: m.role, text: String(m.text) }));

  let response;
  try {
    response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, history, focus }),
      signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError' || signal?.aborted) throw aborted();
    const wrapped = new Error(`chat request failed: ${err?.message || err}`);
    wrapped.code = 'NO_BACKEND';
    throw wrapped;
  }

  if (!response.ok) {
    let body = {};
    try {
      body = await response.json();
    } catch {
      body = {};
    }
    const scope = body?.scope || body?.error || '';
    const err = new Error(`chat backend error (${response.status})`);
    err.status = response.status;
    err.scope = scope || undefined;
    err.retryAfterSeconds = body?.retryAfterSeconds ?? null;
    err.resetAt = body?.resetAt ?? null;
    if (scope) err.code = scope;
    else if (response.status === 402) err.code = 'SPEND_CAP';
    else if (response.status === 503) err.code = 'NOT_CONFIGURED';
    else if (response.status === 404) err.code = 'NO_BACKEND';
    throw err;
  }

  if (signal?.aborted) throw aborted();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const onAbort = () => {
    reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', onAbort);
  try {
    while (true) {
      if (signal?.aborted) throw aborted();
      const { done, value } = await reader.read();
      if (signal?.aborted) throw aborted();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        let event;
        try {
          event = JSON.parse(line.slice(6));
        } catch {
          continue;
        }
        if (event.type === 'meta' || event.type === 'text') {
          yield event;
        } else if (event.type === 'error') {
          if (event.code === 'refusal') throw new Error(event.message || 'The model declined to answer that.');
          if (event.scope) {
            const failure = new Error(event.message || 'chat');
            failure.scope = event.scope;
            failure.retryAfterSeconds = event.retryAfterSeconds ?? null;
            failure.resetAt = event.resetAt ?? null;
            failure.status = event.scope === 'auth' ? 401 : 429;
            failure.code = event.scope;
            throw failure;
          }
          const failure = event.code === 'quota' ? new BothModelsQuotaError() : new Error(event.message || 'the assistant is unavailable right now');
          if (event.code !== 'quota') failure.code = 'API_ERROR';
          failure.status = event.code === 'quota' ? 429 : 503;
          throw failure;
        } else if (event.type === 'done') {
          return;
        }
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}
