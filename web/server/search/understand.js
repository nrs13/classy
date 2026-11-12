import Anthropic from '@anthropic-ai/sdk';
import { assertUnderCap, recordUsage } from '../chat/spend.js';
import { logEvent, safeErrorFields } from '../obs/log.js';
import { createQueryCache } from '../providers/embedding/index.js';
import { query } from '../repo/pool.js';

export const UNDERSTAND_TIMEOUT_MS = 1200;
const BACKGROUND_TIMEOUT_MS = 8000;
const KINDS = ['said', 'on_screen', 'scene', 'any'];

export function understandModel(env = process.env) {
  return env.CLASSY_UNDERSTAND_MODEL || 'claude-haiku-4-5';
}

const SYSTEM = `You read one query typed into the search box of a library of short social videos (mostly students, school and study apps, in many languages) and return what it means.

english: what the user is looking for, as a short English search phrase. Translate when the query is not English. Drop request framing ("find", "the video where", "a clip about") and drop any language or on-screen mention that belongs in another field. Keep names, numbers and quoted text exactly as written. Never add details the query does not contain.
queryLanguage: ISO 639-1 code of the language the query is written in.
languages: ISO 639-1 codes of the language the user explicitly wants the video to be in ("japanese video" gives ["ja"]). Empty when they do not say. The language the query is written in is not a request.
kind: "said" when they ask for something spoken, "on_screen" for text shown on screen, "scene" for something visible happening, otherwise "any".
describesWholeVideo: true when the query describes what a whole video is about rather than one line or moment.`;

const TOOL = {
  name: 'understood',
  description: 'Return the meaning of the search query.',
  input_schema: {
    type: 'object',
    properties: {
      english: { type: 'string' },
      queryLanguage: { type: 'string' },
      languages: { type: 'array', items: { type: 'string' } },
      kind: { type: 'string', enum: KINDS },
      describesWholeVideo: { type: 'boolean' },
    },
    required: ['english', 'queryLanguage', 'languages', 'kind', 'describesWholeVideo'],
  },
};

const ENGLISH_FUNCTION_WORDS = new Set(
  'a an the of to in on at and or is are was were be been how what who whom why when where which with without for from my your his her their our its i you he she they we it about that this these those do does did up out into after before while because than then so not no'.split(' '),
);
const OTHER_FUNCTION_WORDS = new Set(
  'de del la las los el en y que con por para una unos le les des du et est pour avec sur dans der das und ist ein eine nicht mit auf zu den dem il che per della di um uma não com ao os bir ve bu için'.split(' '),
);
const HINTS =
  /\b(english|japanese|german|spanish|french|italian|portuguese|turkish|polish|greek|filipino|korean|chinese|on[- ]screen|caption|subtitle|written|says?|said|saying|video|clip|scene|whole)\b/i;

/**
 * Whether a query is worth sending to the model. Quoted text is literal, one-word queries
 * are names or tags, and plain English with no language or kind hint gains nothing.
 */
export function needsUnderstanding(parsed) {
  if (!parsed || parsed.exactOnly) return false;
  const text = parsed.normalized || '';
  if (text.length < 4) return false;
  const words = text.split(/\s+/).filter(Boolean);
  // eslint-disable-next-line no-control-regex
  const ascii = /^[\x00-\x7f]*$/.test(text);
  if (words.length < 2 && ascii) return false;
  if (!ascii) return true;
  if (HINTS.test(text)) return true;
  const english = words.filter((w) => ENGLISH_FUNCTION_WORDS.has(w)).length;
  const other = words.filter((w) => OTHER_FUNCTION_WORDS.has(w)).length;
  return !(english > 0 && other === 0);
}

/** Coerces model output into the shape search relies on; anything unusable becomes null. */
export function cleanUnderstanding(raw, original) {
  if (!raw || typeof raw !== 'object') return null;
  const english = String(raw.english || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
  if (!english) return null;
  const code = (value) => String(value || '').toLowerCase().slice(0, 2);
  const languages = [...new Set((Array.isArray(raw.languages) ? raw.languages : []).map(code))]
    .filter((c) => /^[a-z]{2}$/.test(c))
    .slice(0, 3);
  const queryLanguage = /^[a-z]{2}$/.test(code(raw.queryLanguage)) ? code(raw.queryLanguage) : '';
  return {
    english,
    queryLanguage,
    languages,
    kind: KINDS.includes(raw.kind) && raw.kind !== 'any' ? raw.kind : null,
    describesWholeVideo: raw.describesWholeVideo === true,
    rewritten: english.toLowerCase() !== String(original || '').toLowerCase(),
  };
}

const memory = createQueryCache(500);

async function readCache(model, text) {
  try {
    const result = await query(
      `SELECT result FROM query_understanding WHERE model = $1 AND query_norm = $2`,
      [model, text],
    );
    return result.rows[0]?.result || null;
  } catch {
    return null;
  }
}

async function writeCache(model, text, result) {
  try {
    await query(
      `INSERT INTO query_understanding (model, query_norm, result) VALUES ($1, $2, $3)
       ON CONFLICT (model, query_norm) DO UPDATE SET result = EXCLUDED.result, created_at = now()`,
      [model, text, result],
    );
  } catch {
    /* the cache is an optimisation */
  }
}

async function callModel({ client, model, text }) {
  assertUnderCap();
  const message = await client.messages.create(
    {
      model,
      max_tokens: 300,
      system: SYSTEM,
      tools: [TOOL],
      tool_choice: { type: 'tool', name: TOOL.name },
      messages: [{ role: 'user', content: text }],
    },
    { timeout: BACKGROUND_TIMEOUT_MS, maxRetries: 0 },
  );
  recordUsage(model, message.usage);
  return message.content.find((block) => block.type === 'tool_use')?.input || null;
}

const inflight = new Map();

/**
 * Meaning of a query: { english, queryLanguage, languages, kind, describesWholeVideo, rewritten }
 * or null. Answers from memory, then Postgres, then the model. A model answer slower than
 * `timeoutMs` is not waited for, but still lands in the cache for the next search.
 */
export async function understandQuery(parsed, { timeoutMs = UNDERSTAND_TIMEOUT_MS, requestId, env = process.env, client } = {}) {
  if (!needsUnderstanding(parsed) || !env.ANTHROPIC_API_KEY) return { result: null, source: 'skipped' };
  const model = understandModel(env);
  const text = parsed.normalized;
  const key = `${model}|${text}`;
  if (memory.get(key)) return { result: memory.get(key), source: 'memory' };
  const stored = await readCache(model, text);
  if (stored) {
    memory.set(key, stored);
    return { result: stored, source: 'cache' };
  }
  if (!inflight.has(key)) {
    const started = Date.now();
    const pending = callModel({ client: client || new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }), model, text })
      .then((raw) => {
        const result = cleanUnderstanding(raw, text);
        if (result) {
          memory.set(key, result);
          writeCache(model, text, result);
        }
        logEvent({ requestId, route: 'search', event: 'understand', model, ms: Date.now() - started, ok: Boolean(result) });
        return result;
      })
      .catch((err) => {
        logEvent({ level: 'warn', requestId, route: 'search', event: 'understand_failed', model, ...safeErrorFields(err) });
        return null;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const outcome = await Promise.race([inflight.get(key), timeout]);
  clearTimeout(timer);
  if (outcome === 'timeout') return { result: null, source: 'timeout' };
  return { result: outcome, source: outcome ? 'model' : 'failed' };
}
