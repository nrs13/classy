import { query } from './pool.js';

export const VIDEO_ID = /^v\d+$/;

export async function listVideos(snapshotId) {
  const result = await query(
    `SELECT c.video_id, c.duration, c.language, c.account, c.plays, c.likes, c.comments, c.followers,
            c.like_rate, c.amplification, c.hook_slope, c.peak_mean_abs, c.sustain_ratio,
            c.timing_eligible, c.cuts, c.curve, c.frames, c.networks, c.topics, c.keywords, i.url
     FROM clip c
     LEFT JOIN ingest i ON i.video_id = c.video_id
     WHERE c.snapshot_id = $1
     ORDER BY c.video_id`,
    [snapshotId],
  );
  return result.rows;
}

export async function videoMeta(snapshotId, ids) {
  if (!ids.length) return new Map();
  const result = await query(
    `SELECT video_id, account, language, duration, plays, sprite_meta
     FROM clip
     WHERE snapshot_id = $1 AND video_id = ANY($2::text[])`,
    [snapshotId, ids],
  );
  return new Map(result.rows.map((row) => [row.video_id, row]));
}

export async function clipsForChat(snapshotId, ids) {
  const result = await query(
    `SELECT video_id, duration, language, account, plays, likes, comments, followers,
            like_rate, amplification, hook_slope, peak_mean_abs, sustain_ratio,
            timing_eligible, cuts, curve, networks, topics, keywords
     FROM clip
     WHERE snapshot_id = $1 AND video_id = ANY($2::text[])`,
    [snapshotId, ids],
  );
  return result.rows;
}

export async function peerClips(snapshotId, excludeIds, limit = 5) {
  const result = await query(
    `SELECT video_id, account, plays, topics
     FROM clip
     WHERE snapshot_id = $1 AND NOT (video_id = ANY($2::text[]))
     ORDER BY plays DESC NULLS LAST
     LIMIT $3`,
    [snapshotId, excludeIds.length ? excludeIds : [''], limit],
  );
  return result.rows;
}

export async function hookSlopes(snapshotId) {
  const result = await query(
    `SELECT hook_slope FROM clip WHERE snapshot_id = $1`,
    [snapshotId],
  );
  return {
    n: result.rows.length,
    slopes: result.rows.map((row) => Number(row.hook_slope)).filter((n) => Number.isFinite(n)),
  };
}

export async function agreedAppMarks(snapshotId, ids) {
  const result = await query(
    `SELECT video_id, t_sec, app
     FROM second
     WHERE snapshot_id = $1 AND video_id = ANY($2::text[]) AND app IS NOT NULL
     ORDER BY video_id, t_sec`,
    [snapshotId, ids],
  );
  return result.rows;
}

const SECOND_AT = `video_id, t_sec, speech, speech_score, text_on_screen, speaker, scenes, outcomes, app, ask`;

export async function secondsAt(snapshotId, ids, tSec) {
  const params = [snapshotId, ids, tSec];
  const where = `snapshot_id = $1 AND video_id = ANY($2::text[]) AND t_sec = $3`;
  try {
    const result = await query(
      `SELECT ${SECOND_AT}, happens FROM second WHERE ${where}`,
      params,
    );
    return result.rows;
  } catch (err) {
    if (err?.code !== '42703') throw err;
    const result = await query(`SELECT ${SECOND_AT} FROM second WHERE ${where}`, params);
    return result.rows;
  }
}

export async function clipDetail(snapshotId, id) {
  const result = await query(
    `SELECT timing_eligible, cuts, language, topics, keywords
     FROM clip WHERE snapshot_id = $1 AND video_id = $2`,
    [snapshotId, id],
  );
  return result.rows[0] || null;
}

const SECOND_COLUMNS = `t_sec, speech, speech_score, text_on_screen, speaker, labels, face_count,
            music_score, sentiment, scenes, outcomes, app, ask`;

export async function secondsForChat(snapshotId, id) {
  const cols = 't_sec, speech, text_on_screen, speaker';
  try {
    const result = await query(
      `SELECT ${cols}, happens
       FROM second
       WHERE snapshot_id = $1 AND video_id = $2
       ORDER BY t_sec`,
      [snapshotId, id],
    );
    return result.rows;
  } catch (err) {
    if (err?.code !== '42703') throw err;
    const result = await query(
      `SELECT ${cols}
       FROM second
       WHERE snapshot_id = $1 AND video_id = $2
       ORDER BY t_sec`,
      [snapshotId, id],
    );
    return result.rows.map((row) => ({ ...row, happens: null }));
  }
}

export async function secondsFor(snapshotId, id) {
  try {
    const result = await query(
      `SELECT ${SECOND_COLUMNS}, happens
       FROM second
       WHERE snapshot_id = $1 AND video_id = $2
       ORDER BY t_sec`,
      [snapshotId, id],
    );
    return result.rows;
  } catch (err) {
    if (err?.code !== '42703') throw err;
    const result = await query(
      `SELECT ${SECOND_COLUMNS}
       FROM second
       WHERE snapshot_id = $1 AND video_id = $2
       ORDER BY t_sec`,
      [snapshotId, id],
    );
    return result.rows.map((row) => ({ ...row, happens: null }));
  }
}

export async function mediaObjects(snapshotId, id) {
  const result = await query(
    `SELECT mp4_object, act_object, sprite_object FROM clip WHERE snapshot_id = $1 AND video_id = $2`,
    [snapshotId, id],
  );
  return result.rows[0] || null;
}

export async function liveMediaObjects(id) {
  const result = await query(
    `SELECT c.mp4_object, c.act_object, c.sprite_object
     FROM pointer p
     JOIN snapshot s ON s.id = p.snapshot_id AND s.complete
     JOIN clip c ON c.snapshot_id = s.id AND c.video_id = $1`,
    [id],
  );
  return result.rows[0] || null;
}

function secondsFromLiveRows(rows) {
  if (!rows.length) return null;
  const first = rows[0];
  return {
    snapshotId: first.snapshot_id,
    quoteFloor: first.quote_floor,
    timingEligible: first.timing_eligible,
    cuts: first.cuts || [],
    language: first.language || '',
    topics: first.topics || '',
    keywords: first.keywords || '',
    seconds: rows.filter((row) => row.t_sec != null).map((row) => ({
      t_sec: row.t_sec,
      speech: row.speech || '',
      speech_score: row.speech_score,
      speaker: row.speaker || '',
      text_on_screen: row.text_on_screen || [],
      labels: row.labels || [],
      face_count: row.face_count,
      music_score: row.music_score,
      sentiment: row.sentiment,
      scenes: row.scenes || [],
      outcomes: row.outcomes || [],
      app: row.app,
      ask: row.ask,
      happens: row.happens || '',
    })),
  };
}

export async function liveSeconds(id) {
  const select = (happens) => `
    SELECT snap.id AS snapshot_id, snap.quote_floor,
           c.timing_eligible, c.cuts, c.language, c.topics, c.keywords,
           sec.t_sec, sec.speech, sec.speech_score, sec.text_on_screen, sec.speaker,
           sec.labels, sec.face_count, sec.music_score, sec.sentiment, sec.scenes,
           sec.outcomes, sec.app, sec.ask${happens ? ', sec.happens' : ''}
    FROM pointer p
    JOIN snapshot snap ON snap.id = p.snapshot_id AND snap.complete
    JOIN clip c ON c.snapshot_id = snap.id AND c.video_id = $1
    LEFT JOIN second sec ON sec.snapshot_id = c.snapshot_id AND sec.video_id = c.video_id
    ORDER BY sec.t_sec
  `;
  try {
    const result = await query(select(true), [id]);
    return secondsFromLiveRows(result.rows);
  } catch (err) {
    if (err?.code !== '42703') throw err;
    const result = await query(select(false), [id]);
    return secondsFromLiveRows(result.rows.map((row) => ({ ...row, happens: null })));
  }
}

/** Speech and speaker around each moment, used for before/after context lines. */
export async function speechWindows(snapshotId, moments, radius = 6) {
  if (!moments.length) return new Map();
  const ids = moments.map((m) => m.videoId);
  const from = moments.map((m) => Math.max(0, m.tSec - radius));
  const to = moments.map((m) => m.tSec + radius);
  const result = await query(
    `SELECT s.video_id, s.t_sec, s.speech, s.speaker
     FROM second s
     JOIN unnest($2::text[], $3::int[], $4::int[]) AS w(video_id, t_from, t_to)
       ON s.video_id = w.video_id AND s.t_sec BETWEEN w.t_from AND w.t_to
     WHERE s.snapshot_id = $1
     ORDER BY s.video_id, s.t_sec`,
    [snapshotId, ids, from, to],
  );
  const out = new Map();
  for (const row of result.rows) {
    if (!out.has(row.video_id)) out.set(row.video_id, []);
    out.get(row.video_id).push(row);
  }
  return out;
}

export async function speakerCounts(snapshotId, ids) {
  if (!ids.length) return new Map();
  const result = await query(
    `SELECT video_id, count(DISTINCT speaker) AS n
     FROM second
     WHERE snapshot_id = $1 AND video_id = ANY($2::text[]) AND coalesce(speaker, '') <> ''
     GROUP BY video_id`,
    [snapshotId, ids],
  );
  return new Map(result.rows.map((row) => [row.video_id, Number(row.n)]));
}

/** One real line per kind (said, on screen, scene), stable for a snapshot. */
export async function exampleLines(snapshotId, limit = 3) {
  const result = await query(
    `SELECT DISTINCT ON (field) field, text
     FROM chunk
     WHERE snapshot_id = $1
       AND field IN ('speech', 'text_on_screen', 'scene')
       AND length(text) BETWEEN 18 AND 70
       AND text ~ '^[[:alpha:]"¿¡]'
       AND array_length(regexp_split_to_array(text, '\\s+'), 1) >= 3
     ORDER BY field, md5(snapshot_id || text)`,
    [snapshotId],
  );
  const order = ['speech', 'text_on_screen', 'scene'];
  return result.rows
    .sort((a, b) => order.indexOf(a.field) - order.indexOf(b.field))
    .slice(0, limit)
    .map((row) => row.text.replace(/[.!?]+$/, ''));
}
