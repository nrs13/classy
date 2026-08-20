import Anthropic from '@anthropic-ai/sdk';
import { prepareKnowledgeForModel, systemPreamble } from '../src/lib/prompt.js';

export const PRIMARY_MODEL = process.env.CLASSY_MODEL || 'claude-opus-5';
export const FALLBACK_MODEL = 'claude-haiku-4-5';
const MAX_HISTORY_MESSAGES = 40;
const MAX_MESSAGE_CHARS = 4000;

/** Module-scoped so warm invocations reuse the knowledge pack. */
let knowledgeCache = null;

async function loadKnowledge(req) {
  if (knowledgeCache) return knowledgeCache;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const res = await fetch(`${proto}://${host}/data/knowledge.json`);
  if (!res.ok) throw new Error(`knowledge.json fetch failed (${res.status})`);
  knowledgeCache = await res.json();
  return knowledgeCache;
}

function toAnthropicMessages(history, message) {
  const messages = [];
  const recent = Array.isArray(history) ? history.slice(-MAX_HISTORY_MESSAGES) : [];
  for (const msg of recent) {
    const text = typeof msg?.text === 'string' ? msg.text.trim() : '';
    if (!text || msg.error) continue;
    if (msg.role !== 'user' && msg.role !== 'model') continue;
    messages.push({
      role: msg.role === 'model' ? 'assistant' : 'user',
      content: text.slice(0, MAX_MESSAGE_CHARS),
    });
  }
  while (messages.length && messages[0].role !== 'user') messages.shift();
  if (messages.length && messages[messages.length - 1].role === 'user') messages.pop();
  messages.push({ role: 'user', content: String(message).slice(0, MAX_MESSAGE_CHARS) });
  return messages;
}

function send(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(503).json({ error: 'not_configured' });
    return;
  }
  const { message, history } = req.body || {};
  if (!message || typeof message !== 'string' || !message.trim()) {
    res.status(400).json({ error: 'empty_message' });
    return;
  }

  let system;
  try {
    const knowledge = await loadKnowledge(req);
    system = systemPreamble(prepareKnowledgeForModel(knowledge));
  } catch (err) {
    res.status(502).json({ error: 'knowledge_unavailable', detail: String(err?.message || err) });
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
        // Chat is latency-sensitive; the dataset is fully in context, so deep
        // reasoning adds seconds without changing 3-6 sentence answers much.
        output_config: { effort: process.env.CLASSY_EFFORT || 'low' },
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
      if (final.stop_reason === 'refusal') {
        send(res, { type: 'error', code: 'refusal', message: 'the model declined to answer that.' });
      }
      send(res, { type: 'done' });
      res.end();
      return;
    } catch (err) {
      const isQuota = err instanceof Anthropic.RateLimitError || err?.status === 429;
      // Once tokens have been sent we cannot cleanly restart on the fallback model.
      if (isQuota && !isLast && !announced) continue;
      send(res, {
        type: 'error',
        code: isQuota ? 'quota' : 'api_error',
        message: String(err?.message || err).slice(0, 300),
      });
      send(res, { type: 'done' });
      res.end();
      return;
    }
  }
}
