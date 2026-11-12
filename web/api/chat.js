import {
  deliverOpenClip,
  normalizeFocus,
} from '../src/lib/prompt.js';
import { buildSystemPrompt } from '../server/chat/promptBlocks.js';
import { openKnowledge } from '../server/chat/knowledge.js';
import { resolveChatConfig, streamProvider, ChatProviderError } from '../server/chat/provider.js';
import { CANNED_ONLY, CHAT_PAUSED, chatStatus, effectiveChatMode, liveFallbackText, matchCanned, visitorCountry } from '../server/chat/mode.js';
import { chatFault, mockFaultError, mockSlowMs } from '../server/chat/mock.js';
import { agreedAppAnswer, clipControlsAnswer, computedAnswer } from '../server/chat/computed.js';
import { applyLenses } from '../server/chat/lenses.js';
import { assertUnderCap, recordUsage } from '../server/chat/spend.js';
import { MAX_CHAT_BODY_BYTES, MAX_HISTORY_MESSAGES, MAX_MESSAGE_CHARS, messageTooLong, messageTooShort } from '../src/lib/chatLimits.js';
import { chatCacheKey, readChatCache, writeChatCache } from '../server/chat/cache.js';
import { chatSends } from '../server/chat/idempotency.js';
import { CHAT_TIMEOUT_MS, MAX_OUTPUT_TOKENS, chatGuardFor, clientIp } from '../server/chat/guard.js';
import { nextPacificMidnight } from '../server/chat/resetAt.js';
import { failureBody } from '../server/chat/classify.js';
import { AppError, errorBody } from '../server/obs/errors.js';
import { logEvent, requestIdFrom, safeErrorFields } from '../server/obs/log.js';

export const maxDuration = 60;

export function abortUpstreamOnDisconnect(req, res, abort) {
  const stop = () => {
    if (!res.writableEnded) abort.abort();
  };
  req.on?.('aborted', stop);
  return stop;
}

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
    const status = chatStatus(process.env, country);
    const guard = chatGuardFor().inspect(clientIp(req));
    res.status(200).json({
      ...status,
      state: guard.state,
      resetAt: guard.resetAt,
      retryAfterSeconds: guard.retryAfterSeconds,
    });
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
  const { message, history, focus, suggested } = req.body || {};
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
  // A newline would split a log line. Longer than 80 is not a client id.
  const supplied = String(req.headers?.['idempotency-key'] || req.headers?.['Idempotency-Key'] || '').trim();
  let badKey = supplied.length > 80;
  for (let i = 0; i < supplied.length && !badKey; i += 1) {
    const code = supplied.charCodeAt(i);
    if (code < 32 || code === 127) badKey = true;
  }
  if (supplied && badKey) {
    fail(res, 400, 'bad_request', requestId);
    return;
  }
  if (mode === 'off') {
    refuse(res, CHAT_PAUSED);
    return;
  }
  const focusNorm = normalizeFocus(focus);
  if (focusNorm.view === 'compare' && focusNorm.ids.length < 2) {
    refuse(res, 'Another reel is needed before Classy can compare.');
    return;
  }
  if (mode === 'canned') {
    const stored = matchCanned(message, focusNorm);
    if (stored) {
      refuse(res, applyLenses(stored, focusNorm.modes));
      return;
    }
    try {
      const opened = await openKnowledge(focusNorm, message);
      const clip = opened.knowledge?.videos?.[0];
      const computed = computedAnswer(message, clip, opened.pack)
        || clipControlsAnswer(message, clip, focusNorm.timeSec)
        || agreedAppAnswer(message, clip, focusNorm.timeSec);
      refuse(res, computed ? applyLenses(computed, focusNorm.modes) : CANNED_ONLY);
    } catch {
      refuse(res, CANNED_ONLY);
    }
    return;
  }
  if (suggested === true) {
    const stored = matchCanned(message, focusNorm);
    if (stored) {
      refuse(res, applyLenses(stored, focusNorm.modes));
      return;
    }
  }
  const storedFact = matchCanned(message, focusNorm);
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
  const threaded = Array.isArray(history) && history.some((item) => item && item.text);
  const cached = threaded ? null : readChatCache(chatCacheKey(message, focusNorm));
  if (cached) {
    refuse(res, cached);
    return;
  }
  const idemKey = supplied ? `${supplied}|${focusNorm.modes.join(',')}`.slice(0, 120) : '';
  const claim = chatSends.claim(idemKey);
  if (!claim.fresh) {
    if (claim.replay?.kind === 'json') {
      if (claim.replay.retryAfterSeconds) res.setHeader('Retry-After', String(claim.replay.retryAfterSeconds));
      res.status(claim.replay.status).json(claim.replay.body);
      return;
    }
    if (claim.replay?.kind === 'sse') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      if (claim.replay.text) send(res, { type: 'text', text: claim.replay.text });
      send(res, { type: 'done' });
      res.end();
      return;
    }
    sendFailure(res, requestId, { scope: 'visitor_rate', retryAfterSeconds: 2, status: 429 });
    return;
  }
  const finish = (record) => chatSends.finish(idemKey, record);
  try {
    chatGuardFor().take(clientIp(req));
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    const scope = err.scope || err.code;
    sendFailure(res, requestId, {
      scope,
      retryAfterSeconds: err.retryAfterSeconds ?? null,
      resetAt: scope === 'day_quota' || scope === 'own_daily_cap' ? (err.resetAt || nextPacificMidnight(Date.now())) : (err.resetAt ?? null),
      status: err.status,
    });
    finish({
      kind: 'json',
      status: quotaStatus(scope, err.status),
      retryAfterSeconds: err.retryAfterSeconds ?? null,
      body: failureBody(requestId, {
        scope,
        retryAfterSeconds: err.retryAfterSeconds ?? null,
        resetAt: scope === 'day_quota' || scope === 'own_daily_cap' ? (err.resetAt || nextPacificMidnight(Date.now())) : (err.resetAt ?? null),
      }),
    });
    return;
  }
  const earlyFault = chatConfig.provider === 'mock' ? mockFaultError(chatFault(req)) : null;
  if (earlyFault) {
    const failure = {
      scope: earlyFault.scope,
      retryAfterSeconds: earlyFault.retryAfterSeconds,
      resetAt: earlyFault.resetAt,
      status: earlyFault.status,
    };
    if ((failure.scope === 'day_quota' || failure.scope === 'own_daily_cap') && !failure.resetAt) {
      failure.resetAt = nextPacificMidnight(Date.now());
    }
    logChatFailure(requestId, chatConfig.provider, failure);
    sendFailure(res, requestId, failure);
    finish({
      kind: 'json',
      status: quotaStatus(failure.scope, failure.status),
      retryAfterSeconds: failure.retryAfterSeconds,
      body: failureBody(requestId, failure),
    });
    return;
  }

  const messages = toAnthropicMessages(history, message);
  const abort = new AbortController();
  abortUpstreamOnDisconnect(req, res, abort);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  send(res, { type: 'open' });

  let openedClip = null;
  let openedPack = null;
  let system;
  try {
    const opened = await openKnowledge(focusNorm, message);
    if (opened.error) {
      send(res, { type: 'text', text: opened.error });
      send(res, { type: 'done' });
      res.end();
      finish({ kind: 'sse', text: opened.error });
      return;
    }
    const delivered = deliverOpenClip(opened.knowledge, focusNorm);
    openedClip = opened.knowledge?.videos?.[0] || null;
    openedPack = opened.pack || null;
    system = buildSystemPrompt(delivered, focusNorm, storedFact);
  } catch (err) {
    logEvent({ level: 'error', requestId, route: 'chat', ...safeErrorFields(err), code: 'library_unavailable' });
    const text = 'Your Library is not available right now.';
    send(res, { type: 'text', text });
    send(res, { type: 'done' });
    res.end();
    finish({ kind: 'sse', text });
    return;
  }

  let announced = false;
  let acc = '';
  try {
    for await (const event of streamProvider(chatConfig, {
      system,
      messages,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      timeoutMs: CHAT_TIMEOUT_MS,
      signal: abort.signal,
      fault: chatFault(req),
      slowMs: mockSlowMs(req),
    })) {
      if (event.type === 'text') {
        if (!announced) {
          announced = true;
          send(res, { type: 'meta', model: event.model });
        }
        acc += event.text || '';
        send(res, { type: 'text', text: event.text });
      } else if (event.type === 'cut') {
        res.end();
        finish({ kind: 'sse', text: acc });
        return;
      } else if (event.type === 'usage' && chatConfig.provider === 'anthropic') {
        recordUsage(event.model, event.usage);
      } else if (event.type === 'refusal') {
        send(res, { type: 'error', code: 'refusal', message: 'the model declined to answer that.' });
      }
    }
    if (!threaded && acc.trim()) writeChatCache(chatCacheKey(message, focusNorm), acc);
    send(res, { type: 'done' });
    res.end();
    finish({ kind: 'sse', text: acc });
  } catch (err) {
    if (err?.name === 'AbortError' || err?.code === 'ABORTED') {
      finish({ kind: 'sse', text: acc });
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
    if ((failure.scope === 'day_quota' || failure.scope === 'own_daily_cap') && !failure.resetAt) {
      failure.resetAt = nextPacificMidnight(Date.now());
    }
    logChatFailure(requestId, chatConfig.provider, failure);
    if (!announced && !res.headersSent) {
      sendFailure(res, requestId, failure);
      finish({
        kind: 'json',
        status: quotaStatus(failure.scope, failure.status),
        retryAfterSeconds: failure.retryAfterSeconds,
        body: failureBody(requestId, failure),
      });
      return;
    }
    const fallback = announced ? null : liveFallbackText(failure.scope, message, focusNorm, undefined, openedClip, openedPack);
    if (fallback && failure.scope !== 'auth') {
      send(res, { type: 'text', text: fallback });
      send(res, { type: 'done' });
      res.end();
      finish({ kind: 'sse', text: fallback });
      return;
    }
    send(res, {
      type: 'error',
      error: failure.scope,
      scope: failure.scope,
      retryAfterSeconds: failure.retryAfterSeconds,
      resetAt: failure.resetAt,
      requestId,
      message: CHAT_PAUSED,
    });
    send(res, { type: 'done' });
    res.end();
    finish({ kind: 'sse', text: acc });
  }
}
