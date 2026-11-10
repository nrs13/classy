import { createHash } from 'node:crypto';
import { query } from './pool.js';

/** embedding_cache profile for query vectors: the document profile's space plus the query model. */
export function queryProfile(provider) {
  return `${String(provider.profile).replace(/\|document$/, '')}|query|${provider.queryModel}`;
}

function hashOf(text) {
  return createHash('sha256').update(text).digest('hex');
}

export async function readQueryVector(provider, text) {
  try {
    const result = await query(
      `SELECT vector::text AS v FROM embedding_cache WHERE profile = $1 AND text_hash = $2`,
      [queryProfile(provider), hashOf(text)],
    );
    const raw = result.rows[0]?.v;
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function writeQueryVector(provider, text, vector) {
  try {
    await query(
      `INSERT INTO embedding_cache (profile, text_hash, vector) VALUES ($1, $2, $3::vector)
       ON CONFLICT (profile, text_hash) DO NOTHING`,
      [queryProfile(provider), hashOf(text), `[${vector.join(',')}]`],
    );
  } catch {
    /* the cache is an optimisation */
  }
}
