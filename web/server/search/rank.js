import { containsWholeWords } from './query.js';

export const RRF_K = 60;
const COLLAPSE_SEC = 3;

/**
 * Field weights start empty: plain reciprocal rank fusion. Add a weight here only with the
 * evaluation run (catalog/eval/results) that showed it raised recall@5 and MRR without
 * lowering any language.
 */
export const FIELD_WEIGHTS = Object.freeze({});

function hitKey(hit) {
  return `${hit.videoId}|${hit.tSec}|${hit.field}|${hit.text}`;
}

/**
 * Reciprocal rank fusion. Each list is already ordered best first. Per lane, a hit also records
 * `videoRank` (its video's position among distinct videos) and `relative` (score / lane's best).
 */
export function fuseRanks(lists, { k = RRF_K, weights = FIELD_WEIGHTS } = {}) {
  const fused = new Map();
  for (const { lane, family = lane, hits } of lists) {
    const videoOrder = new Map();
    const top = Number(hits[0]?.score) || 0;
    hits.forEach((hit, index) => {
      if (!videoOrder.has(hit.videoId)) videoOrder.set(hit.videoId, videoOrder.size + 1);
      const key = hitKey(hit);
      const prior = fused.get(key) || { ...hit, score: 0, lanes: {}, families: {} };
      const weight = weights[hit.field] ?? 1;
      // Lanes of one family (a query and its rewrite) are one signal: the better rank counts.
      const contribution = weight / (k + index + 1);
      const before = prior.families[family] || 0;
      if (contribution > before) {
        prior.score += contribution - before;
        prior.families[family] = contribution;
      }
      prior.lanes[lane] = {
        rank: index + 1,
        videoRank: videoOrder.get(hit.videoId),
        score: hit.score,
        relative: top > 0 && Number.isFinite(Number(hit.score)) ? Number(hit.score) / top : null,
      };
      if (hit.exact) prior.exact = true;
      fused.set(key, prior);
    });
  }
  return [...fused.values()].sort((a, b) => b.score - a.score || a.tSec - b.tSec);
}

/** Marks keyword hits whose text contains the whole normalized query as words, for names and on-screen text. */
export function markExact(hits, normalizedQuery) {
  if (!normalizedQuery || normalizedQuery.length < 2) return hits;
  return hits.map((hit) => (containsWholeWords(hit.text, normalizedQuery) ? { ...hit, exact: true } : hit));
}

/** Within a video, hits less than COLLAPSE_SEC apart become one moment; the best hit leads. */
export function collapseMoments(hits, windowSec = COLLAPSE_SEC) {
  const kept = [];
  for (const hit of hits) {
    const near = kept.find((m) => m.videoId === hit.videoId && Math.abs(m.tSec - hit.tSec) < windowSec);
    if (near) {
      near.alsoMatched = (near.alsoMatched || 0) + 1;
      for (const [lane, value] of Object.entries(hit.lanes || {})) {
        if (!near.lanes[lane]) near.lanes[lane] = value;
      }
      if (hit.exact) near.exact = true;
      continue;
    }
    kept.push({ ...hit, lanes: { ...(hit.lanes || {}) } });
  }
  return kept;
}

export const WORD_LANES = ['keyword', 'keyword_en'];
export const MEANING_LANES = ['vector', 'vector_en'];
/** One lane at rank 1: enough to break ties toward a requested language, never to override relevance. */
export const LANGUAGE_BONUS = 1 / (RRF_K + 1);

/** Soft boost for moments in a language the query asked for (understanding, never a filter). */
export function boostLanguages(hits, languages, bonus = LANGUAGE_BONUS) {
  if (!languages?.length) return hits;
  const boosted = hits.map((hit) => {
    const lang = String(hit.language || '').toLowerCase();
    return languages.some((code) => lang.startsWith(code)) ? { ...hit, score: hit.score + bonus, boosted: true } : hit;
  });
  return boosted.sort((a, b) => b.score - a.score || a.tSec - b.tSec);
}

/** Retrieval-only label: how a moment matched the query. */
export function matchOf(moment) {
  if (moment.exact) return 'exact';
  const lanes = moment.lanes || {};
  const words = WORD_LANES.some((lane) => lanes[lane]);
  const meaning = MEANING_LANES.some((lane) => lanes[lane]);
  if (words && meaning) return 'words_and_meaning';
  return words ? 'words' : 'meaning';
}

const DECAY = [1, 0.5, 0.25];

/**
 * Group moments by video. Exact hits on the whole query lead; then the group score.
 * scoring 'max': the best moment. 'decay': best + 0.5 second + 0.25 third, so a video that
 * matches in several places beats one stray line. `videoHits` (whole-video documents) add
 * their fused score to their video and stand in as the moment when nothing else matched.
 */
export function groupByVideo(
  moments,
  { maxMoments = 3, scoring = 'max', videoHits = [], videoWeight = 1, videoCombine = 'sum' } = {},
) {
  const groups = new Map();
  const groupFor = (videoId) => {
    if (!groups.has(videoId)) groups.set(videoId, { videoId, score: 0, exact: false, moments: [], momentCount: 0, parts: [] });
    return groups.get(videoId);
  };
  for (const moment of moments) {
    const group = groupFor(moment.videoId);
    group.momentCount += 1;
    if (group.moments.length < maxMoments) group.moments.push(moment);
    group.parts.push(moment.score);
    if (moment.exact) group.exact = true;
  }
  const bestDoc = new Map();
  for (const hit of videoHits) {
    if (!bestDoc.has(hit.videoId) || bestDoc.get(hit.videoId).score < hit.score) bestDoc.set(hit.videoId, hit);
  }
  for (const [videoId, doc] of bestDoc) {
    const group = groupFor(videoId);
    group.videoDoc = doc;
    if (!group.moments.length) group.moments.push(doc);
  }
  for (const group of groups.values()) {
    const parts = [...group.parts].sort((a, b) => b - a);
    const momentScore =
      scoring === 'decay' ? parts.slice(0, DECAY.length).reduce((sum, value, i) => sum + value * DECAY[i], 0) : parts[0] || 0;
    const docScore = videoWeight * (group.videoDoc?.score || 0);
    group.score = videoCombine === 'max' ? Math.max(momentScore, docScore) : momentScore + docScore;
    delete group.parts;
  }
  return [...groups.values()].sort((a, b) => Number(b.exact) - Number(a.exact) || b.score - a.score);
}
