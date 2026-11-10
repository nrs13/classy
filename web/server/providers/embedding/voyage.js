import { formatDocument, formatQuery } from './format.js';
import { assertUnit, l2normalize } from './vectors.js';

const ENDPOINT = 'https://api.voyageai.com/v1/embeddings';

/** All voyage-4 models share one vector space, so the profile names the series, not the model. */
export function voyageSeries(model) {
  const match = /^voyage-(\d+(?:\.\d+)?)/.exec(model || '');
  return match ? `${match[1]}-series` : model;
}

export function createVoyageProvider(env = process.env, overrides = {}) {
  const key = env.VOYAGE_API_KEY || '';
  const dim = Number(overrides.dim || env.CLASSY_EMBED_DIM || 1024);
  const documentModel = overrides.documentModel || env.CLASSY_EMBED_DOC_MODEL || 'voyage-4-large';
  const queryModel = overrides.queryModel || env.CLASSY_EMBED_QUERY_MODEL || 'voyage-4-lite';
  const timeoutMs = Number(overrides.timeoutMs || env.CLASSY_EMBED_TIMEOUT_MS || 2500);
  const fetchImpl = overrides.fetch || fetch;
  const profile = `voyage|${voyageSeries(documentModel)}|${dim}|document`;

  async function call(input, model, inputType, timeout) {
    if (!key) throw new Error('embedding_not_configured');
    const response = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ input, model, input_type: inputType, output_dimension: dim }),
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) throw new Error(`embedding_http_${response.status}`);
    const payload = await response.json();
    const rows = Array.isArray(payload?.data) ? [...payload.data].sort((a, b) => a.index - b.index) : [];
    if (rows.length !== input.length) throw new Error('embedding_count_mismatch');
    return rows.map((row) => assertUnit(l2normalize(row.embedding), dim));
  }

  return {
    name: 'voyage',
    profile,
    dim,
    queryModel,
    documentModel,
    configured: Boolean(key),
    async embedQuery(text) {
      const [vector] = await call([formatQuery(text)], queryModel, 'query', timeoutMs);
      return vector;
    },
    async embedQueries(texts) {
      return call(texts.map(formatQuery), queryModel, 'query', 60000);
    },
    async embedDocuments(texts) {
      return call(texts.map(formatDocument), documentModel, 'document', 120000);
    },
  };
}
