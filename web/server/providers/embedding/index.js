import { createVoyageProvider } from './voyage.js';
import { createGeminiProvider } from './gemini.js';

/**
 * Embedding contract.
 *   profile               string stored on the snapshot; vectors are comparable only within one profile
 *   queryModel            model used by embedQuery (logged per request)
 *   embedQuery(text)      search time only, query input type, one unit-length vector
 *   embedQueries(texts)   same, batched (evaluation), vectors in input order
 *   embedDocuments(texts) ingestion only, document input type, unit-length vectors in input order
 * Providers never touch the database.
 */
export function getEmbeddingProvider(env = process.env, overrides = {}) {
  const name = (overrides.provider || env.CLASSY_EMBED_PROVIDER || 'voyage').toLowerCase();
  if (name === 'gemini') return createGeminiProvider(env, overrides);
  return createVoyageProvider(env, overrides);
}

export { assertUnit, l2normalize } from './vectors.js';
export { formatDocument, formatQuery } from './format.js';

/** Small LRU for query vectors, keyed by profile, query model and normalized text. */
export function createQueryCache(max = 500) {
  const map = new Map();
  return {
    get(key) {
      if (!map.has(key)) return undefined;
      const value = map.get(key);
      map.delete(key);
      map.set(key, value);
      return value;
    },
    set(key, value) {
      if (map.has(key)) map.delete(key);
      map.set(key, value);
      while (map.size > max) map.delete(map.keys().next().value);
    },
    get size() {
      return map.size;
    },
  };
}
