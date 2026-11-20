import pg from 'pg';

const { Pool } = pg;

let pool;

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (process.env.VERCEL) return '';
  return 'postgresql:///classy';
}

function getPool() {
  const connectionString = databaseUrl();
  if (!connectionString) return null;
  if (!pool) {
    const serverless = Boolean(process.env.VERCEL);
    pool = new Pool({
      connectionString,
      max: serverless ? 1 : 4,
      idleTimeoutMillis: serverless ? 10_000 : 30_000,
      connectionTimeoutMillis: 8_000,
      statement_timeout: 8000,
    });
  }
  return pool;
}

export async function query(text, params) {
  const db = getPool();
  if (!db) {
    const error = new Error('database_unconfigured');
    error.code = 'NO_DATABASE';
    throw error;
  }
  return db.query(text, params);
}

const HNSW_SETTINGS = "SET LOCAL hnsw.iterative_scan = 'strict_order'; SET LOCAL hnsw.ef_search = 100";

/**
 * Runs a nearest-neighbour query with pgvector 0.8 iterative scan, so the snapshot filter
 * cannot leave fewer than LIMIT rows. Older pgvector without these settings runs it plainly.
 */
export async function vectorQuery(text, params) {
  const db = getPool();
  if (!db) return query(text, params);
  const client = await db.connect();
  try {
    try {
      await client.query(`BEGIN; ${HNSW_SETTINGS}`);
    } catch {
      await client.query('ROLLBACK');
      return await client.query(text, params);
    }
    const result = await client.query(text, params);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool() {
  if (pool) {
    const current = pool;
    pool = null;
    await current.end();
  }
}
