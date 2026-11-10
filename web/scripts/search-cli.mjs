#!/usr/bin/env node
/**
 * Runs Library search for a batch of queries without HTTP. Used by catalog/eval/run.py and
 * pack_snapshot.py --validate. Reads JSON from stdin:
 *   { snapshotId?, queryModel?, mode?, weights?, options?, queries: [{ id, q }] }
 * Writes JSON to stdout: [{ id, mode, notice, fellBack, results: [{ videoId, moments: [tSec] }] }]
 * `fellBack` is true when the snapshot and provider profiles match but a search still had to
 * show exact matches only (embedding error or rate limit).
 *
 * Query vectors are fetched in one batched request first (retrying on rate limits), so an
 * evaluation costs one embedding call instead of one per query.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function loadEnv(path) {
  let raw = '';
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const i = trimmed.indexOf('=');
    if (i < 1) continue;
    const key = trimmed.slice(0, i).trim();
    const value = trimmed.slice(i + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnv(join(here, '..', '.env.local'));
process.env.CLASSY_LOG = process.env.CLASSY_LOG || 'off';
const { assertDevDatabase } = await import('../server/repo/productionGuard.js');
assertDevDatabase();

const { searchLibrary } = await import('../server/search/service.js');
const { parseQuery } = await import('../server/search/query.js');
const { getEmbeddingProvider } = await import('../server/providers/embedding/index.js');
const { closePool } = await import('../server/repo/pool.js');
const { currentSnapshot, snapshotById } = await import('../server/repo/snapshot.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withRetry(fn, attempts = 6) {
  let delay = 20_000;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      const retryable = /embedding_http_(429|5\d\d)/.test(String(err?.message));
      if (!retryable || attempt === attempts) throw err;
      process.stderr.write(`query embedding ${err.message}; retrying in ${delay / 1000}s\n`);
      await sleep(delay);
      delay = Math.min(delay * 2, 120_000);
    }
  }
}

/** Provider whose embedQuery answers from one batched request. */
async function batchedProvider(queries, queryModel) {
  const base = getEmbeddingProvider(process.env, queryModel ? { queryModel } : {});
  if (!base.configured || !base.embedQueries) return base;
  const texts = [...new Set(queries.map((item) => parseQuery(item.q).normalized).filter(Boolean))];
  const vectors = new Map();
  for (let i = 0; i < texts.length; i += 128) {
    const part = texts.slice(i, i + 128);
    const out = await withRetry(() => base.embedQueries(part));
    part.forEach((text, j) => vectors.set(text, out[j]));
  }
  return {
    ...base,
    async embedQuery(text) {
      return vectors.get(text) || base.embedQuery(text);
    },
  };
}

const input = JSON.parse(readFileSync(0, 'utf8'));
const queries = input.queries || [];
const mode = input.mode || 'auto';
const out = [];
try {
  const snapshot = input.snapshotId ? await snapshotById(input.snapshotId) : await currentSnapshot();
  const base = getEmbeddingProvider(process.env, input.queryModel ? { queryModel: input.queryModel } : {});
  const vectorsExpected =
    mode !== 'exact' && base.configured && Boolean(snapshot?.embeddingProfile) && snapshot.embeddingProfile === base.profile;
  const provider = vectorsExpected ? await batchedProvider(queries, input.queryModel) : undefined;
  for (const item of queries) {
    const body = await searchLibrary({
      q: item.q,
      limit: 10,
      mode,
      snapshotId: input.snapshotId || undefined,
      queryModel: input.queryModel || undefined,
      weights: input.weights || undefined,
      understandTimeoutMs: 10_000,
      ...(input.options || {}),
      provider,
    });
    out.push({
      id: item.id,
      mode: body.mode,
      notice: body.notice,
      fellBack: vectorsExpected && Boolean(body.notice),
      ms: body.timing?.total ?? null,
      results: body.results.map((r) => ({
        videoId: r.videoId,
        moments: [r.best, ...r.more].map((m) => m.tSec),
      })),
    });
  }
} finally {
  await closePool();
}
process.stdout.write(JSON.stringify(out));
