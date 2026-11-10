import Anthropic from '@anthropic-ai/sdk';
import {
  deliverOpenClip,
  normalizeFocus,
  openClipPreamble,
} from '../src/lib/prompt.js';
import { openKnowledge } from '../server/chat/knowledge.js';
import { assertUnderCap, recordUsage } from '../server/chat/spend.js';
import { rateLimit } from '../server/http.js';
import { MAX_CHAT_BODY_BYTES, MAX_HISTORY_MESSAGES, MAX_MESSAGE_CHARS, messageTooLong } from '../src/lib/chatLimits.js';
import { AppError, errorBody } from '../server/obs/errors.js';
import { logEvent, requestIdFrom } from '../server/obs/log.js';

export const PRIMARY_MODEL = process.env.CLASSY_MODEL || 'claude-opus-5';
export const FALLBACK_MODEL = 'claude-haiku-4-5';

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
  if (req.method === 'GET') {
    if (!process.env.ANTHROPIC_API_KEY) {
      fail(res, 503, 'not_configured', requestId);
      return;
    }
    try {
      assertUnderCap();
    } catch {
      fail(res, 402, 'spend_cap', requestId);
      return;
    }
    res.status(204).end();
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
  if (!process.env.ANTHROPIC_API_KEY) {
    fail(res, 503, 'not_configured', requestId);
    return;
  }
  try {
    assertUnderCap();
  } catch (err) {
    fail(res, 402, 'spend_cap', requestId);
    return;
  }
  try {
    rateLimit(req, { name: 'chat', max: 12, windowMs: 60_000 });
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    res.status(429).json(errorBody(requestId, err.code, err.userMessage));
    return;
  }
  const focusNorm = normalizeFocus(focus);
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

  const client = new Anthropic();
  const messages = toAnthropicMessages(history, message);
  const chain = PRIMARY_MODEL === FALLBACK_MODEL ? [PRIMARY_MODEL] : [PRIMARY_MODEL, FALLBACK_MODEL];

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });

  for (let i = 0; i < chain.length; i++) {
    const model = chain[i];
    const isLast = i === chain.length - 1;
    let announced = false;
    try {
      const stream = client.messages.stream({
        model,
        max_tokens: 4096,
        ...(model.startsWith('claude-haiku')
          ? {}
          : { output_config: { effort: process.env.CLASSY_EFFORT || 'low' } }),
        system: [
          {
            type: 'text',
            text: system,
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages,
      });
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          if (!announced) {
            announced = true;
            send(res, { type: 'meta', model });
          }
          send(res, { type: 'text', text: event.delta.text });
        }
      }
      const final = await stream.finalMessage();
      recordUsage(model, final.usage);
      if (final.stop_reason === 'refusal') {
        send(res, { type: 'error', code: 'refusal', message: 'the model declined to answer that.' });
      }
      send(res, { type: 'done' });
      res.end();
      return;
    } catch (err) {
      const isQuota = err instanceof Anthropic.RateLimitError || err?.status === 429;
      if (isQuota && !isLast && !announced) continue;
      logEvent({ level: 'error', requestId, route: 'chat', model, status: err?.status, error: String(err?.message || err).slice(0, 2000) });
      send(res, {
        type: 'error',
        code: isQuota ? 'quota' : 'api_error',
        message: err?.status === 401 || err?.status === 403 ? 'api key rejected' : 'the assistant is unavailable right now',
      });
      send(res, { type: 'done' });
      res.end();
      return;
    }
  }
}
