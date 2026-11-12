import { query, vectorQuery } from './pool.js';

const KIND_FIELDS = {
  said: ['segment', 'speech', 'ask'],
  on_screen: ['text_on_screen'],
  scene: ['scene', 'evidence', 'video'],
};

const ROW = `k.id, k.video_id, k.t_sec, k.end_sec, k.field, k.text, k.confidence, k.speaker, k.context,
  coalesce(nullif(k.language, ''), c.language) AS language`;

function filterSql(filters, params) {
  const clauses = [];
  if (filters.lang) {
    params.push(`${filters.lang}%`);
    clauses.push(`coalesce(nullif(k.language, ''), c.language) ILIKE $${params.length}`);
  }
  if (filters.kind && KIND_FIELDS[filters.kind]) {
    params.push(KIND_FIELDS[filters.kind]);
    clauses.push(`k.field = ANY($${params.length}::text[])`);
  }
  if (filters.account) {
    params.push(filters.account);
    clauses.push(`c.account = $${params.length}`);
  }
  return clauses.length ? ` AND ${clauses.join(' AND ')}` : '';
}

function shape(row) {
  return {
    id: Number(row.id),
    videoId: row.video_id,
    tSec: row.t_sec,
    endSec: row.end_sec ?? null,
    field: row.field,
    text: row.text,
    confidence: row.confidence,
    speaker: row.speaker || '',
    context: row.context || null,
    language: row.language || '',
    score: row.score == null ? null : Number(row.score),
  };
}

/**
 * Exact-word lane. websearch_to_tsquery keeps quoted phrases as phrases and ANDs the rest.
 * With `relaxed`, terms are ORed and lines covering more distinct query words rank first, so
 * common words ("de", "the") cannot outrank a line that matches most of the query.
 * Whole-video documents are left to the meaning lane: a long text contains most words of
 * any query and would crowd out the lines that actually say them.
 */
export async function keywordCandidates({ snapshotId, text, relaxed = false, filters = {}, limit = 50 }) {
  const params = [snapshotId, text];
  const tsq = relaxed
    ? `replace(websearch_to_tsquery('simple', $2)::text, ' & ', ' | ')::tsquery`
    : `websearch_to_tsquery('simple', $2)`;
  let coverage = '0';
  if (relaxed) {
    const words = await queryWords(text);
    coverage = words.length
      ? words
          .map((word) => {
            params.push(word);
            return `(k.tsv @@ plainto_tsquery('simple', $${params.length}))::int`;
          })
          .join(' + ')
      : '0';
  }
  const where = filterSql(filters, params);
  params.push(limit);
  const result = await query(
    `WITH q AS (SELECT ${tsq} AS tsq)
     SELECT * FROM (
       SELECT DISTINCT ON (k.video_id, k.field, k.text) ${ROW},
              ${coverage} AS covered,
              ts_rank_cd(k.tsv, q.tsq, 1) AS score
       FROM chunk k
       JOIN clip c ON c.snapshot_id = k.snapshot_id AND c.video_id = k.video_id
       CROSS JOIN q
       WHERE k.snapshot_id = $1 AND k.field <> 'video' AND numnode(q.tsq) > 0 AND k.tsv @@ q.tsq${where}
       ORDER BY k.video_id, k.field, k.text, k.t_sec
     ) first_seen
     ORDER BY covered DESC, score DESC, video_id, t_sec
     LIMIT $${params.length}`,
    params,
  );
  return result.rows.map(shape);
}

const MAX_COVERAGE_WORDS = 16;

async function queryWords(text) {
  const result = await query(`SELECT tsvector_to_array(to_tsvector('simple', $1)) AS words`, [text]);
  return (result.rows[0]?.words || []).slice(0, MAX_COVERAGE_WORDS);
}

function likePattern(text) {
  return `%${text.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/**
 * Whole-query substring lane (trigram index). Catches text the word parser cannot split, such
 * as Japanese, and names glued to punctuation. Shorter lines rank first: the closer the line
 * is to the query, the more exact the hit.
 */
export async function substringCandidates({ snapshotId, text, filters = {}, limit = 50 }) {
  const params = [snapshotId, likePattern(text)];
  const where = filterSql(filters, params);
  params.push(limit);
  const result = await query(
    `SELECT * FROM (
       SELECT DISTINCT ON (k.video_id, k.field, k.text) ${ROW},
              1.0 / length(k.text) AS score
       FROM chunk k
       JOIN clip c ON c.snapshot_id = k.snapshot_id AND c.video_id = k.video_id
       WHERE k.snapshot_id = $1 AND k.field <> 'video' AND k.text ILIKE $2${where}
       ORDER BY k.video_id, k.field, k.text, k.t_sec
     ) first_seen
     ORDER BY score DESC, video_id, t_sec
     LIMIT $${params.length}`,
    params,
  );
  return result.rows.map(shape);
}

/** Fields never shown as a moment (brain-network labels, tag lists, topic labels). */
const HIDDEN_FIELDS = ['video', 'activation', 'keyword', 'topic'];

/**
 * Cosine lane over this snapshot's vectors, one row per distinct line (its first second; see
 * is_repeat in catalog/schema.sql). `k.dimension = dim`, `NOT k.is_repeat` and the cast must
 * match the partial HNSW index.
 */
export async function vectorCandidates({ snapshotId, vector, dim, filters = {}, limit = 50 }) {
  if (!Number.isInteger(dim) || dim <= 0 || dim > 4096) throw new Error('bad_dimension');
  const params = [snapshotId, `[${vector.join(',')}]`, HIDDEN_FIELDS];
  const where = filterSql(filters, params);
  params.push(limit * 2);
  const result = await vectorQuery(
    `SELECT ${ROW}, 1 - (k.embedding::vector(${dim}) <=> $2::vector(${dim})) AS score
     FROM chunk k
     JOIN clip c ON c.snapshot_id = k.snapshot_id AND c.video_id = k.video_id
     WHERE k.snapshot_id = $1 AND k.field <> ALL($3::text[]) AND k.dimension = ${dim} AND NOT k.is_repeat
       AND k.embedding IS NOT NULL${where}
     ORDER BY k.embedding::vector(${dim}) <=> $2::vector(${dim})
     LIMIT $${params.length}`,
    params,
  );
  const seen = new Map();
  for (const row of result.rows.map(shape)) {
    const key = `${row.videoId}|${row.field}|${row.text}`;
    if (!seen.has(key)) seen.set(key, row);
  }
  return [...seen.values()].slice(0, limit);
}

/**
 * Whole-video documents ranked by cosine: one per video, so an exact scan over the snapshot's
 * few hundred rows (the `+ 0` keeps the planner off the per-chunk HNSW index).
 */
export async function videoDocCandidates({ snapshotId, vector, dim, filters = {}, limit = 20 }) {
  if (!Number.isInteger(dim) || dim <= 0 || dim > 4096) throw new Error('bad_dimension');
  const params = [snapshotId, `[${vector.join(',')}]`];
  const where = filterSql({ ...filters, kind: '' }, params);
  params.push(limit);
  const result = await query(
    `SELECT ${ROW}, 1 - (k.embedding::vector(${dim}) <=> $2::vector(${dim})) AS score
     FROM chunk k
     JOIN clip c ON c.snapshot_id = k.snapshot_id AND c.video_id = k.video_id
     WHERE k.snapshot_id = $1 AND k.field = 'video' AND k.dimension = ${dim} AND k.embedding IS NOT NULL${where}
     ORDER BY (k.embedding::vector(${dim}) <=> $2::vector(${dim})) + 0
     LIMIT $${params.length}`,
    params,
  );
  return result.rows.map(shape);
}
