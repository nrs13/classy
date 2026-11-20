import { query } from './pool.js';

const COLUMNS = `s.id, s.embedding_model, s.embedding_dim, s.embedding_profile, s.quote_floor, s.complete`;
const MEMORY_MS = 15_000;
let memo = { at: 0, value: undefined };

export function clearSnapshotCache() {
  memo = { at: 0, value: undefined };
}

function shape(row) {
  if (!row) return null;
  return {
    id: row.id,
    embeddingModel: row.embedding_model || null,
    embeddingDim: row.embedding_dim ? Number(row.embedding_dim) : null,
    embeddingProfile: row.embedding_profile || null,
    quoteFloor: row.quote_floor,
  };
}

/** Read the pointer once per request; every later query in that request uses this id. */
export async function currentSnapshot() {
  const now = Date.now();
  if (memo.value !== undefined && now - memo.at < MEMORY_MS) return memo.value;
  const result = await query(
    `SELECT ${COLUMNS}
     FROM pointer p
     JOIN snapshot s ON s.id = p.snapshot_id
     WHERE p.id = 1 AND s.complete`,
  );
  const value = shape(result.rows[0]);
  if (value) memo = { at: now, value };
  return value;
}

/** For evaluation and validation only: a complete snapshot that may not be live yet. */
export async function snapshotById(id) {
  const result = await query(`SELECT ${COLUMNS} FROM snapshot s WHERE s.id = $1 AND s.complete`, [id]);
  return shape(result.rows[0]);
}
