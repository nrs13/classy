import {
  deliverOpenClip,
  normalizeFocus,
  openClipPreamble,
} from '../src/lib/prompt.js';
import { openKnowledge } from '../server/chat/knowledge.js';
import { resolveChatConfig, streamProvider, ChatProviderError } from '../server/chat/provider.js';
import { CANNED_ONLY, CHAT_PAUSED, chatMode, chatStatus, matchCanned } from '../server/chat/mode.js';
import { assertUnderCap, recordUsage } from '../server/chat/spend.js';
import { rateLimit } from '../server/http.js';
import { MAX_CHAT_BODY_BYTES, MAX_HISTORY_MESSAGES, MAX_MESSAGE_CHARS, messageTooLong } from '../src/lib/chatLimits.js';
import { AppError, errorBody } from '../server/obs/errors.js';
import { logEvent, requestIdFrom } from '../server/obs/log.js';

function refuse(res, text) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  send(res, { type: 'text', text });
  send(res, { type: 'done' });
  res.end();
}

function toAnthropicMessages(history, message) {
  const messages = [];
  const recent = Array.isArray(history) ? history.slice(-MAX_HISTORY_MESSAGES) : [];
  for (const msg of recent) {
    const text = typeof msg?.text === 'string' ? msg.text.trim() : '';
    if (!text || msg.error) continue;
    if (msg.role !== 'user' && msg.role !== 'assistant') continue;
    messages.push({
      role: msg.role,
      content: text.slice(0, MAX_MESSAGE_CHARS),
    });
  }
  while (messages.length && messages[0].role !== 'user') messages.shift();
  if (messages.length && messages[messages.length - 1].role === 'user') messages.pop();
  messages.push({ role: 'user', content: String(message) });
  return messages;
}

function send(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function fail(res, status, error, requestId) {
  res.status(status).json(errorBody(requestId, error));
}

export default async function handler(req, res) {
  const requestId = requestIdFrom(req);
  if (typeof res.setHeader === 'function') res.setHeader('X-Request-Id', requestId);
  const chatConfig = resolveChatConfig();
  const mode = chatMode();
  if (req.method === 'GET') {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(chatStatus());
    return;
  }
  if (req.method !== 'POST') {
    fail(res, 405, 'method_not_allowed', requestId);
    return;
  }
  const bodyBytes = Buffer.byteLength(JSON.stringify(req.body ?? {}));
  if (bodyBytes > MAX_CHAT_BODY_BYTES) {
    fail(res, 413, 'payload_too_large', requestId);
    return;
  }
  const { message, history, focus } = req.body || {};
  if (!message || typeof message !== 'string' || !message.trim()) {
    fail(res, 400, 'empty_message', requestId);
    return;
  }
  if (messageTooLong(message)) {
    fail(res, 400, 'message_too_long', requestId);
    return;
  }
  if (mode === 'off') {
    refuse(res, CHAT_PAUSED);
    return;
  }
  const focusNorm = normalizeFocus(focus);
  if (mode === 'canned') {
    refuse(res, matchCanned(message, focusNorm) || CANNED_ONLY);
    return;
  }
  if (!chatConfig.apiKey) {
    fail(res, 503, 'not_configured', requestId);
    return;
  }
  if (chatConfig.provider === 'anthropic') {
  try {
    assertUnderCap();
  } catch {
    fail(res, 402, 'spend_cap', requestId);
    return;
  }
  }
  try {
    rateLimit(req, { name: 'chat', max: 12, windowMs: 60_000 });
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    res.status(429).json(errorBody(requestId, err.code, err.userMessage));
    return;
  }
  let system;
  try {
    const opened = await openKnowledge(focusNorm);
    if (opened.error) {
      refuse(res, opened.error);
      return;
    }
    const delivered = deliverOpenClip(opened.knowledge, focusNorm);
    system = openClipPreamble(delivered, focusNorm);
  } catch (err) {
    logEvent({ level: 'error', requestId, route: 'chat', code: 'library_unavailable', error: String(err?.message || err) });
    res.status(502).json(errorBody(requestId, 'library_unavailable'));
    return;
  }

  const messages = toAnthropicMessages(history, message);
  const abort = new AbortController();
  req.on?.('aborted', () => abort.abort());

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });

  let announced = false;
  try {
    for await (const event of streamProvider(chatConfig, {
      system,
      messages,
      maxOutputTokens: 4096,
      signal: abort.signal,
    })) {
      if (event.type === 'text') {
        if (!announced) {
          announced = true;
          send(res, { type: 'meta', model: event.model });
        }
        send(res, { type: 'text', text: event.text });
      } else if (event.type === 'usage' && chatConfig.provider === 'anthropic') {
        recordUsage(event.model, event.usage);
      } else if (event.type === 'refusal') {
        send(res, { type: 'error', code: 'refusal', message: 'the model declined to answer that.' });
      }
    }
    send(res, { type: 'done' });
    res.end();
  } catch (err) {
    if (err?.name === 'AbortError' || err?.code === 'ABORTED') {
      if (!res.writableEnded) res.end();
      return;
    }
    const errorType = err instanceof ChatProviderError ? err.errorType : 'server';
    const status = err instanceof ChatProviderError ? err.status : 0;
    logEvent({
      level: 'error',
      requestId,
      route: 'chat',
      provider: chatConfig.provider,
      status,
      errorType,
    });
    send(res, {
      type: 'error',
      code: errorType === 'quota' ? 'quota' : 'api_error',
      message: errorType === 'auth' ? 'api key rejected' : 'the assistant is unavailable right now',
    });
    send(res, { type: 'done' });
    res.end();
  }
}
