import { query } from './pool.js';

export async function listIngest(limit = 200) {
  const result = await query(
    `SELECT video_id, url, state, detail, updated_at
     FROM ingest
     ORDER BY updated_at DESC
     LIMIT $1`,
    [limit],
  );
  return result.rows;
}

export async function upsertIngest({ videoId, url, state, detail }) {
  await query(
    `INSERT INTO ingest (video_id, url, state, detail, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (video_id) DO UPDATE
     SET url = EXCLUDED.url,
         state = EXCLUDED.state,
         detail = EXCLUDED.detail,
         updated_at = now()`,
    [videoId, url, state, detail],
  );
}
