import {
  deliverOpenClip,
  normalizeFocus,
} from '../src/lib/prompt.js';
import { buildSystemPrompt } from '../server/chat/promptBlocks.js';
import { openKnowledge } from '../server/chat/knowledge.js';
import { resolveChatConfig, streamProvider, ChatProviderError } from '../server/chat/provider.js';
import { CANNED_ONLY, CHAT_PAUSED, chatStatus, effectiveChatMode, liveFallbackText, matchCanned, visitorCountry } from '../server/chat/mode.js';
import { assertUnderCap, recordUsage } from '../server/chat/spend.js';
import { MAX_CHAT_BODY_BYTES, MAX_HISTORY_MESSAGES, MAX_MESSAGE_CHARS, messageTooLong, messageTooShort } from '../src/lib/chatLimits.js';
import { chatCacheKey, readChatCache, writeChatCache } from '../server/chat/cache.js';
import { CHAT_TIMEOUT_MS, MAX_OUTPUT_TOKENS, chatGuardFor, clientIp } from '../server/chat/guard.js';
import { failureBody } from '../server/chat/classify.js';
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

function quotaStatus(scope, status) {
  if (scope === 'auth') return status === 403 ? 403 : 401;
  if (scope === 'timeout') return 504;
  if (scope === 'network') return 503;
  if (scope === 'server') return status >= 500 ? status : 502;
  return 429;
}

function sendFailure(res, requestId, failure) {
  const body = failureBody(requestId, failure);
  if (failure.retryAfterSeconds) res.setHeader('Retry-After', String(failure.retryAfterSeconds));
  res.status(quotaStatus(failure.scope, failure.status)).json(body);
}

function logChatFailure(requestId, provider, failure) {
  logEvent({
    level: 'error',
    requestId,
    route: 'chat',
    provider,
    status: failure.status || 0,
    errorType: failure.scope,
  });
}

export default async function handler(req, res) {
  const requestId = requestIdFrom(req);
  if (typeof res.setHeader === 'function') res.setHeader('X-Request-Id', requestId);
  const chatConfig = resolveChatConfig();
  const country = visitorCountry(req.headers);
  const mode = effectiveChatMode(process.env, country);
  if (req.method === 'GET') {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(chatStatus(process.env, country));
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
  if (messageTooShort(message)) {
    fail(res, 400, 'message_too_short', requestId);
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
  const cached = readChatCache(chatCacheKey(message, focusNorm));
  if (cached) {
    refuse(res, cached);
    return;
  }
  try {
    chatGuardFor().take(clientIp(req));
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    sendFailure(res, requestId, {
      scope: err.scope || err.code,
      retryAfterSeconds: err.retryAfterSeconds ?? null,
      resetAt: err.resetAt ?? null,
      status: err.status,
    });
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
    system = buildSystemPrompt(delivered, focusNorm);
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
  let acc = '';
  try {
    for await (const event of streamProvider(chatConfig, {
      system,
      messages,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      timeoutMs: CHAT_TIMEOUT_MS,
      signal: abort.signal,
    })) {
      if (event.type === 'text') {
        if (!announced) {
          announced = true;
          send(res, { type: 'meta', model: event.model });
        }
        acc += event.text || '';
        send(res, { type: 'text', text: event.text });
      } else if (event.type === 'usage' && chatConfig.provider === 'anthropic') {
        recordUsage(event.model, event.usage);
      } else if (event.type === 'refusal') {
        send(res, { type: 'error', code: 'refusal', message: 'the model declined to answer that.' });
      }
    }
    if (acc.trim()) writeChatCache(chatCacheKey(message, focusNorm), acc);
    send(res, { type: 'done' });
    res.end();
  } catch (err) {
    if (err?.name === 'AbortError' || err?.code === 'ABORTED') {
      if (!res.writableEnded) res.end();
      return;
    }
    const errorType = err instanceof ChatProviderError ? err.errorType : 'server';
    const status = err instanceof ChatProviderError ? err.status : 0;
    const failure = {
      scope: err instanceof ChatProviderError ? err.scope || errorType : 'server',
      retryAfterSeconds: err instanceof ChatProviderError ? err.retryAfterSeconds : null,
      resetAt: err instanceof ChatProviderError ? err.resetAt : null,
      status,
    };
    logChatFailure(requestId, chatConfig.provider, failure);
    if (!announced && !res.headersSent) {
      sendFailure(res, requestId, failure);
      return;
    }
    const fallback = announced ? null : liveFallbackText(failure.scope, message, focusNorm);
    if (fallback && failure.scope !== 'auth') {
      send(res, { type: 'text', text: fallback });
      send(res, { type: 'done' });
      res.end();
      return;
    }
    send(res, {
      type: 'error',
      error: failure.scope,
      scope: failure.scope,
      retryAfterSeconds: failure.retryAfterSeconds,
      resetAt: failure.resetAt,
      requestId,
      message: failure.scope === 'auth' ? CHAT_PAUSED : CHAT_PAUSED,
    });
    send(res, { type: 'done' });
    res.end();
  }
}
