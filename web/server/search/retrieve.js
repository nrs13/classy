import { keywordCandidates, substringCandidates, vectorCandidates, videoDocCandidates } from '../repo/chunks.js';
import { containsWholeWords, substringWorthy } from './query.js';
import { markExact } from './rank.js';

export const LANE_LIMIT = 50;
/** Brain-network labels, tag lists and topic labels are not lines anyone said or saw. */
const SKIP_FIELDS = new Set(['activation', 'keyword', 'topic']);

function usable(hits) {
  return hits.filter((hit) => !SKIP_FIELDS.has(hit.field));
}

function appendNew(base, extra) {
  const seen = new Set(base.map((h) => h.id));
  return [...base, ...extra.filter((h) => !seen.has(h.id))];
}

/**
 * Keyword lane, best first: lines containing the whole query as words, then lines with every
 * term (quoted text as a phrase), then lines containing it only inside a longer word, then,
 * when fewer than `relaxBelow` lines have every term, lines covering the most terms.
 */
export async function keywordLane({
  snapshotId,
  parsed,
  relaxBelow = 5,
  repo = { keywordCandidates, substringCandidates },
}) {
  const text = parsed.exactOnly ? `"${parsed.phrase}"` : parsed.text;
  const whole = parsed.exactOnly ? parsed.phrase : parsed.text.replace(/"/g, '');
  const opts = { snapshotId, filters: parsed.filters, limit: LANE_LIMIT };
  const [substring, strict] = await Promise.all([
    substringWorthy(whole) ? repo.substringCandidates({ ...opts, text: whole }) : [],
    repo.keywordCandidates({ ...opts, text }),
  ]);
  const asWords = [];
  const insideWords = [];
  for (const hit of usable(substring)) (containsWholeWords(hit.text, whole) ? asWords : insideWords).push(hit);
  let hits = appendNew(appendNew(asWords, usable(strict)), insideWords);
  if (!parsed.exactOnly && strict.length < relaxBelow) {
    const relaxed = await repo.keywordCandidates({ ...opts, text, relaxed: true });
    hits = appendNew(hits, usable(relaxed));
  }
  return markExact(hits.slice(0, LANE_LIMIT), parsed.normalized);
}

export async function vectorLane({ snapshot, parsed, vector, repo = { vectorCandidates } }) {
  const hits = await repo.vectorCandidates({
    snapshotId: snapshot.id,
    vector,
    dim: snapshot.embeddingDim,
    filters: parsed.filters,
    limit: LANE_LIMIT,
  });
  return usable(hits);
}

/** Videos whose whole-video document is closest in meaning (a video-level ranking). */
export async function videoLane({ snapshot, parsed, vector, repo = { videoDocCandidates } }) {
  if (parsed.filters.kind && parsed.filters.kind !== 'scene') return [];
  return repo.videoDocCandidates({
    snapshotId: snapshot.id,
    vector,
    dim: snapshot.embeddingDim,
    filters: parsed.filters,
    limit: 20,
  });
}
