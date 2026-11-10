import { query } from './pool.js';

const COLUMNS = `s.id, s.embedding_model, s.embedding_dim, s.embedding_profile, s.quote_floor, s.complete`;

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
  const result = await query(
    `SELECT ${COLUMNS}
     FROM pointer p
     JOIN snapshot s ON s.id = p.snapshot_id
     WHERE p.id = 1 AND s.complete`,
  );
  return shape(result.rows[0]);
}

/** For evaluation and validation only: a complete snapshot that may not be live yet. */
export async function snapshotById(id) {
  const result = await query(`SELECT ${COLUMNS} FROM snapshot s WHERE s.id = $1 AND s.complete`, [id]);
  return shape(result.rows[0]);
}
