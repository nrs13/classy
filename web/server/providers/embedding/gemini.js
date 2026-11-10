import { formatDocument, formatQuery } from './format.js';
import { assertUnit, l2normalize } from './vectors.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/** gemini-embedding-001 takes a task type; truncated outputs are not unit length, so we normalize. */
export function createGeminiProvider(env = process.env, overrides = {}) {
  const key = env.GEMINI_API_KEY || env.GOOGLE_API_KEY || '';
  const dim = Number(overrides.dim || env.CLASSY_EMBED_DIM || 768);
  const model = overrides.documentModel || env.CLASSY_EMBED_DOC_MODEL || 'gemini-embedding-001';
  const timeoutMs = Number(overrides.timeoutMs || env.CLASSY_EMBED_TIMEOUT_MS || 2500);
  const fetchImpl = overrides.fetch || fetch;
  const profile = `gemini|${model}|${dim}|retrieval`;

  async function call(texts, taskType, timeout) {
    if (!key) throw new Error('embedding_not_configured');
    const response = await fetchImpl(`${BASE}/${model}:batchEmbedContents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        requests: texts.map((text) => ({
          model: `models/${model}`,
          content: { parts: [{ text }] },
          taskType,
          outputDimensionality: dim,
        })),
      }),
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) throw new Error(`embedding_http_${response.status}`);
    const payload = await response.json();
    const rows = payload?.embeddings || [];
    if (rows.length !== texts.length) throw new Error('embedding_count_mismatch');
    return rows.map((row) => assertUnit(l2normalize(row.values || []), dim));
  }

  return {
    name: 'gemini',
    profile,
    dim,
    queryModel: model,
    documentModel: model,
    configured: Boolean(key),
    async embedQuery(text) {
      const [vector] = await call([formatQuery(text)], 'RETRIEVAL_QUERY', timeoutMs);
      return vector;
    },
    async embedQueries(texts) {
      return call(texts.map(formatQuery), 'RETRIEVAL_QUERY', 60000);
    },
    async embedDocuments(texts) {
      return call(texts.map(formatDocument), 'RETRIEVAL_DOCUMENT', 120000);
    },
  };
}
