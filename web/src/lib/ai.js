export { sanitizeAssistantText } from './sanitizeAssistantText.js';

export async function checkChatBackend() {
  try {
    const res = await fetch('/api/chat', { method: 'GET' });
    if (res.status === 402) return 'spend_cap';
    if (res.ok) return 'ready';
    return 'down';
  } catch {
    return 'down';
  }
}

export class BothModelsQuotaError extends Error {
  constructor(message = 'model quota reached, try again later') {
    super(message);
    this.name = 'BothModelsQuotaError';
    this.code = 'BOTH_MODELS_QUOTA';
  }
}

export function formatChatError(err) {
  if (err?.code === 'BOTH_MODELS_QUOTA' || err instanceof BothModelsQuotaError) {
    return 'model quota reached, try again later';
  }
  const text = String(err?.message || err || 'unknown error');
  if (err?.code === 'SPEND_CAP' || text.includes('402')) {
    return 'local spend cap reached ($8). Chat is paused.';
  }
  if (err?.code === 'NOT_CONFIGURED' || text.includes('503')) {
    return 'no Anthropic API key configured on the server yet.';
  }
  if (err?.code === 'NO_BACKEND' || text.includes('404')) {
    return 'chat backend unreachable. it runs on the deployed site (or locally via `npm run dev` with .env.local).';
  }
  if (text.includes('401') || text.includes('403') || text.toLowerCase().includes('api key')) {
    return 'AI auth failed (API key invalid or revoked).';
  }
  const clipped = text.replace(/\s+/g, ' ').slice(0, 220);
  return `AI error: ${clipped || 'unknown failure'}`;
}

export async function* streamChatReply({ priorMessages = [], message, focus = null }) {
  const history = priorMessages
    .filter((m) => m?.text && (m.role === 'user' || m.role === 'assistant') && !m.error)
    .map((m) => ({ role: m.role, text: String(m.text) }));

  let response;
  try {
    response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, history, focus }),
    });
  } catch (err) {
    const wrapped = new Error(`chat request failed: ${err?.message || err}`);
    wrapped.code = 'NO_BACKEND';
    throw wrapped;
  }

  if (!response.ok) {
    const err = new Error(`chat backend error (${response.status})`);
    if (response.status === 402) err.code = 'SPEND_CAP';
    if (response.status === 503) err.code = 'NOT_CONFIGURED';
    if (response.status === 404) err.code = 'NO_BACKEND';
    throw err;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
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
        if (event.code === 'quota') throw new BothModelsQuotaError();
        throw new Error(event.message || 'AI error');
      } else if (event.type === 'done') {
        return;
      }
    }
  }
}
