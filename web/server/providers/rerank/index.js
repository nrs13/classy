import { createNoRerank } from './none.js';
import { createGeminiRerank } from './gemini.js';

/**
 * Rerank contract: rerank(query, candidates) returns the same candidates, reordered.
 * It runs after Postgres ranking, sees at most the top 20, and must never throw to the caller.
 */
export function getReranker(env = process.env) {
  const name = (env.CLASSY_RERANK || 'none').toLowerCase();
  if (name === 'gemini') return createGeminiRerank(env);
  return createNoRerank();
}
