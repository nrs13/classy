import Anthropic from '@anthropic-ai/sdk';
import {
  deliverOpenClip,
  normalizeFocus,
  openClipPreamble,
} from '../src/lib/prompt.js';
import { openKnowledge } from '../server/chat/knowledge.js';
import { assertUnderCap, recordUsage } from '../server/chat/spend.js';
import { rateLimit } from '../server/http.js';
import { MAX_HISTORY_MESSAGES, MAX_MESSAGE_CHARS, messageTooLong } from '../src/lib/chatLimits.js';
import { AppError } from '../server/obs/errors.js';
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

export default async function handler(req, res) {
  const requestId = requestIdFrom(req);
  if (typeof res.setHeader === 'function') res.setHeader('X-Request-Id', requestId);
  if (req.method === 'GET') {
    if (!process.env.ANTHROPIC_API_KEY) {
      res.status(503).json({ error: 'not_configured' });
      return;
    }
    try {
      assertUnderCap();
    } catch {
      res.status(402).json({ error: 'spend_cap' });
      return;
    }
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }
  const { message, history, focus } = req.body || {};
  if (!message || typeof message !== 'string' || !message.trim()) {
    res.status(400).json({ error: 'empty_message', message: 'That message is empty.' });
    return;
  }
  if (messageTooLong(message)) {
    res.status(400).json({ error: 'message_too_long', message: 'That message is too long.' });
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(503).json({ error: 'not_configured' });
    return;
  }
  try {
    assertUnderCap();
  } catch (err) {
    res.status(402).json({ requestId, error: 'spend_cap', message: err.message });
    return;
  }
  try {
    rateLimit(req, { name: 'chat', max: 12, windowMs: 60_000 });
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    res.status(429).json({ requestId, error: err.code, message: err.userMessage });
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
    res.status(502).json({ requestId, error: 'library_unavailable', message: 'Your Library is unavailable. Try again in a moment.' });
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
