import { AppError } from '../obs/errors.js';
import { logEvent } from '../obs/log.js';
import { createTimer } from '../obs/timing.js';
import { createQueryCache, getEmbeddingProvider } from '../providers/embedding/index.js';
import { getReranker } from '../providers/rerank/index.js';
import { readQueryVector, writeQueryVector } from '../repo/queryVectors.js';
import { currentSnapshot, snapshotById } from '../repo/snapshot.js';
import { exampleLines, speakerCounts, speechWindows, videoMeta } from '../repo/videos.js';
import { explainMoment } from './explain.js';
import { frameOf } from './frames.js';
import { parseQuery } from './query.js';
import { boostLanguages, collapseMoments, FIELD_WEIGHTS, fuseRanks, groupByVideo, matchOf } from './rank.js';
import { keywordLane, vectorLane, videoLane } from './retrieve.js';
import { understandQuery } from './understand.js';

export const EXACT_NOTICE = 'Showing exact matches only right now.';
const RERANK_TOP = 20;

/**
 * Defaults for parts that must earn their place in catalog/eval (run.py --options to A/B).
 *   understand        Claude reads the query (English rewrite, requested language, kind)
 *   understandVector  the English rewrite also searches by meaning (one more embedding)
 *   boost             soft rank bonus for a language the query asked for
 *   scoring           group score: 'max' or 'decay'
 *   videoDocs         whole-video documents add to their video's score: true, false, or
 *                     'described' (only when understanding says the query describes a video).
 *                     Off: on the golden set they did not beat moment-only scoring.
 *   videoDocWeight    share of a whole-video document's fused score added to its video
 *   videoDocCombine   'sum' (document adds to the best moment) or 'max' (the better of the two)
 */
export const SEARCH_DEFAULTS = Object.freeze({
  understand: true,
  understandVector: true,
  boost: true,
  scoring: 'max',
  videoDocs: false,
  videoDocWeight: 1,
  videoDocCombine: 'sum',
});

const queryCache = createQueryCache(500);
const providers = new Map();

function providerFor(queryModel) {
  const key = queryModel || 'default';
  if (!providers.has(key)) providers.set(key, getEmbeddingProvider(process.env, queryModel ? { queryModel } : {}));
  return providers.get(key);
}

/** Memory, then the persistent embedding_cache, then the provider. */
async function embedQueryCached(provider, normalized) {
  const key = `${provider.profile}|${provider.queryModel}|${normalized}`;
  const hit = queryCache.get(key);
  if (hit) return { vector: hit, cache: 'memory' };
  const stored = await readQueryVector(provider, normalized);
  if (stored) {
    queryCache.set(key, stored);
    return { vector: stored, cache: 'db' };
  }
  const vector = await provider.embedQuery(normalized);
  queryCache.set(key, vector);
  writeQueryVector(provider, normalized, vector);
  return { vector, cache: 'none' };
}

function setting(options, name) {
  return options[name] === undefined ? SEARCH_DEFAULTS[name] : options[name];
}

/**
 * Hybrid Library search.
 * Public options: q, lang, field, account, limit, mode ('auto' | 'exact'), examples (with an
 * empty q), understand (false searches exactly what was typed).
 * Internal options (evaluation, validation and scripts only): snapshotId, queryModel, weights,
 * provider, understandVector, boost, scoring, videoDocs, understandTimeoutMs, trace.
 */
export async function searchLibrary(options, { requestId = '' } = {}) {
  const timer = createTimer();
  const parsed = parseQuery(options.q, options);
  const limit = Math.max(1, Math.min(50, Number(options.limit) || 20));
  const snapshot = options.snapshotId ? await snapshotById(options.snapshotId) : await currentSnapshot();
  if (!snapshot) throw new AppError('no_library', 404);
  if (!parsed.text || !parsed.normalized) {
    const examples = options.examples ? await exampleLines(snapshot.id, 3) : [];
    return { requestId, snapshotId: snapshot.id, mode: 'exact', notice: null, results: [], examples };
  }

  const provider = options.provider || providerFor(options.queryModel);
  const wantVector = options.mode !== 'exact' && !parsed.exactOnly;
  const profileMatches = Boolean(snapshot.embeddingProfile) && snapshot.embeddingProfile === provider.profile;
  const vectorReady = wantVector && profileMatches && provider.configured;
  const wantUnderstanding = options.mode !== 'exact' && setting(options, 'understand') !== false;

  const caches = {};
  const embedErrors = [];
  const meaningLane = (lane, text, laneParsed) =>
    (async () => {
      let vector;
      try {
        const embedded = await timer.stage(`embed${lane.slice(6)}`, () => embedQueryCached(provider, text));
        vector = embedded.vector;
        caches[lane] = embedded.cache;
      } catch (err) {
        embedErrors.push(String(err?.message || err));
        return null;
      }
      const wantDocs = setting(options, 'videoDocs') !== false;
      const [hits, docs] = await Promise.all([
        timer.stage(lane, () => vectorLane({ snapshot, parsed: laneParsed, vector })),
        wantDocs ? timer.stage(`video${lane.slice(6)}`, () => videoLane({ snapshot, parsed: laneParsed, vector })) : [],
      ]);
      return { hits, docs };
    })();

  const keywordPromise = timer.stage('keyword', () => keywordLane({ snapshotId: snapshot.id, parsed }));
  const vectorPromise = vectorReady ? meaningLane('vector', parsed.normalized, parsed) : Promise.resolve(null);
  const understandPromise = wantUnderstanding
    ? timer.stage('understand', () =>
        understandQuery(parsed, { requestId, ...(options.understandTimeoutMs ? { timeoutMs: options.understandTimeoutMs } : {}) }),
      )
    : Promise.resolve({ result: null, source: 'off' });

  const { result: understood, source: understandSource } = await understandPromise;
  const englishParsed = understood?.rewritten ? parseQuery(understood.english, options) : null;
  const englishPromises = englishParsed?.normalized
    ? [
        timer.stage('keyword_en', () => keywordLane({ snapshotId: snapshot.id, parsed: englishParsed })),
        vectorReady && setting(options, 'understandVector')
          ? meaningLane('vector_en', englishParsed.normalized, englishParsed)
          : Promise.resolve(null),
      ]
    : [Promise.resolve(null), Promise.resolve(null)];

  const [keywordHits, meaning, keywordEnHits, meaningEn] = await Promise.all([
    keywordPromise,
    vectorPromise,
    ...englishPromises,
  ]);
  const hybrid = Array.isArray(meaning?.hits);
  const notice = wantVector && !hybrid ? EXACT_NOTICE : null;

  const lanes = {
    keyword: keywordHits,
    vector: meaning?.hits ?? null,
    keyword_en: keywordEnHits,
    vector_en: meaningEn?.hits ?? null,
    video: meaning?.docs ?? null,
    video_en: meaningEn?.docs ?? null,
  };
  const lists = Object.entries(lanes)
    .filter(([, hits]) => Array.isArray(hits))
    // Matching the rewrite is not matching what was typed, so it never counts as exact.
    .map(([lane, hits]) => ({
      lane,
      family: lane.replace(/_en$/, ''),
      hits: lane.endsWith('_en') ? hits.map((h) => ({ ...h, exact: false })) : hits,
    }));
  const boostTo = setting(options, 'boost') && !parsed.filters.lang ? understood?.languages || [] : [];
  const scoring = setting(options, 'scoring');

  const fused = await timer.stage('fuse', async () => {
    const hits = boostLanguages(fuseRanks(lists, { weights: options.weights || FIELD_WEIGHTS }), boostTo);
    const docs = setting(options, 'videoDocs');
    const useDocs = docs === 'described' ? Boolean(understood?.describesWholeVideo) : Boolean(docs);
    const videoHits = useDocs ? hits.filter((hit) => hit.field === 'video') : [];
    const moments = collapseMoments(hits.filter((hit) => hit.field !== 'video'));
    return groupByVideo(moments, {
      scoring,
      videoHits,
      videoWeight: setting(options, 'videoDocWeight'),
      videoCombine: setting(options, 'videoDocCombine'),
    });
  });

  const reranker = getReranker();
  const ordered = await timer.stage('rerank', () =>
    reranker.name === 'none'
      ? fused
      : reranker.rerank(parsed.text, fused.slice(0, RERANK_TOP).map(withPreview)).then((top) => [
          ...top,
          ...fused.slice(RERANK_TOP),
        ]),
  );

  const groups = ordered.slice(0, limit);
  const results = await timer.stage('explain', () => explainGroups(snapshot.id, groups));
  timer.total();

  const counts = Object.fromEntries(Object.entries(lanes).map(([lane, hits]) => [lane, hits?.length ?? 0]));
  logEvent({
    requestId,
    route: 'search',
    snapshotId: snapshot.id,
    mode: hybrid ? 'hybrid' : 'exact',
    provider: provider.name,
    queryModel: hybrid ? provider.queryModel : null,
    caches,
    understand: understandSource,
    ms: timer.ms,
    counts: { ...counts, results: results.length },
    filters: parsed.filters,
    rerank: reranker.name,
    ...(embedErrors.length ? { embedError: embedErrors[0] } : {}),
    ...(wantVector && !profileMatches ? { profileMismatch: [snapshot.embeddingProfile, provider.profile] } : {}),
  });

  return {
    requestId,
    snapshotId: snapshot.id,
    mode: hybrid ? 'hybrid' : 'exact',
    notice,
    understood: understood ? { ...understood, boosted: boostTo } : null,
    // The model call outlived the timeout but keeps running and fills the cache: asking again
    // shortly returns the understood results.
    ...(understandSource === 'timeout' ? { understanding: 'pending' } : {}),
    results,
    timing: timer.ms,
    ...(options.trace ? { trace: traceOf(lanes, groups) } : {}),
  };
}

function withPreview(group) {
  return { ...group, best: { quote: group.moments[0]?.text || '' } };
}

async function explainGroups(snapshotId, groups) {
  if (!groups.length) return [];
  const ids = groups.map((g) => g.videoId);
  const moments = groups.flatMap((g) => g.moments.map((m) => ({ videoId: g.videoId, tSec: m.tSec })));
  const [meta, windows, speakers] = await Promise.all([
    videoMeta(snapshotId, ids),
    speechWindows(snapshotId, moments),
    speakerCounts(snapshotId, ids),
  ]);
  return groups.map((group) => {
    const info = meta.get(group.videoId) || {};
    const window = windows.get(group.videoId) || [];
    const shaped = group.moments.map((m) => ({
      ...explainMoment(m, { window, speakers: speakers.get(group.videoId) || 0 }),
      frame: frameOf(info.sprite_meta, m.tSec),
    }));
    return {
      videoId: group.videoId,
      account: info.account || '',
      language: info.language || '',
      duration: info.duration ?? null,
      plays: info.plays == null ? null : Number(info.plays),
      sprite: info.sprite_meta ? { ...info.sprite_meta, url: `/api/media?kind=sprite&id=${group.videoId}` } : null,
      match: matchOf(group.moments[0] || {}),
      momentCount: Math.max(group.momentCount || 0, shaped.length),
      best: shaped[0],
      more: shaped.slice(1),
    };
  });
}

function brief(hit) {
  return {
    videoId: hit.videoId,
    tSec: hit.tSec,
    field: hit.field,
    score: hit.score,
    exact: Boolean(hit.exact),
    language: hit.language || '',
    text: hit.text,
  };
}

/** Lane lists and fused groups, for scripts/search-debug.mjs only. */
function traceOf(lanes, groups) {
  return {
    lanes: Object.fromEntries(
      Object.entries(lanes)
        .filter(([, hits]) => Array.isArray(hits))
        .map(([name, hits]) => [name, hits.slice(0, 25).map(brief)]),
    ),
    groups: groups.map((g) => ({
      videoId: g.videoId,
      score: g.score,
      exact: g.exact,
      videoDoc: g.videoDoc ? g.videoDoc.score : null,
      moments: g.moments.map((m) => ({ ...brief(m), lanes: m.lanes, fused: m.score, boosted: Boolean(m.boosted) })),
    })),
  };
}
