import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.CLASSY_LOG = 'off';
// Unreachable on purpose: the understanding cache read and write must fail quietly.
process.env.DATABASE_URL = 'postgresql://127.0.0.1:1/none';

const { parseQuery } = await import('../server/search/query.js');
const { needsUnderstanding, cleanUnderstanding, understandQuery } = await import('../server/search/understand.js');
const { boostLanguages, matchOf, fuseRanks, LANGUAGE_BONUS } = await import('../server/search/rank.js');
const { frameOf } = await import('../server/search/frames.js');
const { trimQuote } = await import('../server/search/explain.js');
const { highlightParts, errorCopy, searchFailureView, beginSearchState, searchFromUrl, searchToUrl, whyLine, countLine, resultCounts } = await import(
  '../src/lib/search.js'
);

const ENV = { ANTHROPIC_API_KEY: 'test', CLASSY_UNDERSTAND_MODEL: 'claude-haiku-test' };

function fakeClient(answer, { delayMs = 0, fail = false } = {}) {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (body) => {
        calls.push(body);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (fail) throw Object.assign(new Error('overloaded'), { status: 529 });
        return { content: [{ type: 'tool_use', name: 'understood', input: answer }] };
      },
    },
  };
}

const marked = (parts) => parts.filter((p) => p.hit).map((p) => p.text);

test('needsUnderstanding: only queries a model can improve', () => {
  const needs = (q) => needsUnderstanding(parseQuery(q, {}));
  assert.equal(needs('"how many corners"'), false, 'quoted text is literal');
  assert.equal(needs('Knowunity'), false, 'one word is a name or tag');
  assert.equal(needs('how was the math exam'), false, 'plain English');
  assert.equal(needs('japanese video about notes'), true, 'a language request');
  assert.equal(needs('Wie war die Mathearbeit'), true, 'not English');
  assert.equal(needs('テストの準備'), true, 'non-Latin script');
});

test('cleanUnderstanding: coerces model output and marks a rewrite', () => {
  const clean = cleanUnderstanding(
    { english: '  girl   dancing ', queryLanguage: 'ES', languages: ['ja-JP', '12', 'ja'], kind: 'any', describesWholeVideo: 'yes' },
    'chica bailando',
  );
  assert.deepEqual(clean, {
    english: 'girl dancing',
    queryLanguage: 'es',
    languages: ['ja'],
    kind: null,
    describesWholeVideo: false,
    rewritten: true,
  });
  assert.equal(cleanUnderstanding({ english: 'math exam' }, 'Math Exam').rewritten, false);
  assert.equal(cleanUnderstanding({ english: '   ' }, 'x'), null);
  assert.equal(cleanUnderstanding(null, 'x'), null);
});

test('understandQuery: model answer, then memory; skipped without a key', async () => {
  const parsed = parseQuery('chica bailando en el pasillo', {});
  const client = fakeClient({ english: 'girl dancing in the hallway', queryLanguage: 'es', languages: [], kind: 'scene', describesWholeVideo: false });
  const first = await understandQuery(parsed, { env: ENV, client });
  assert.equal(first.source, 'model');
  assert.equal(first.result.english, 'girl dancing in the hallway');
  assert.equal(client.calls[0].tool_choice.name, 'understood');
  const again = await understandQuery(parsed, { env: ENV, client });
  assert.equal(again.source, 'memory');
  assert.equal(client.calls.length, 1);
  assert.equal((await understandQuery(parsed, { env: {}, client })).source, 'skipped');
});

test('understandQuery: a slow answer times out but fills the cache for the next search', async () => {
  const parsed = parseQuery('une lycéenne stressée par le bac', {});
  const client = fakeClient(
    { english: 'stressed high school student and the bac exam', queryLanguage: 'fr', languages: [], kind: 'any', describesWholeVideo: true },
    { delayMs: 120 },
  );
  const slow = await understandQuery(parsed, { env: ENV, client, timeoutMs: 20 });
  assert.deepEqual(slow, { result: null, source: 'timeout' });
  const joined = await understandQuery(parsed, { env: ENV, client, timeoutMs: 1000 });
  assert.equal(joined.source, 'model', 'joins the call already in flight');
  assert.equal(client.calls.length, 1);
  assert.equal((await understandQuery(parsed, { env: ENV, client })).source, 'memory');
});

test('understandQuery: a failed call degrades to no understanding', async () => {
  const parsed = parseQuery('qualquer coisa sobre provas', {});
  const result = await understandQuery(parsed, { env: ENV, client: fakeClient(null, { fail: true }) });
  assert.deepEqual(result, { result: null, source: 'failed' });
});

test('boostLanguages: a requested language breaks ties, never outranks a clear winner', () => {
  const hits = [
    { videoId: 'v1', language: 'en-US', score: 2 / 61 },
    { videoId: 'v2', language: 'en-US', score: 1 / 62 },
    { videoId: 'v3', language: 'ja-JP', score: 1 / 63 },
  ];
  const out = boostLanguages(hits, ['ja']);
  assert.deepEqual(out.map((h) => h.videoId), ['v1', 'v3', 'v2']);
  assert.ok(out.find((h) => h.videoId === 'v3').boosted);
  assert.equal(out.find((h) => h.videoId === 'v3').score, 1 / 63 + LANGUAGE_BONUS);
  assert.equal(boostLanguages(hits, []), hits);
});

test('fuseRanks: a lane and its English rewrite count once, at the better rank', () => {
  const hit = { videoId: 'v1', tSec: 0, field: 'speech', text: 'x' };
  const fused = fuseRanks([
    { lane: 'keyword', family: 'keyword', hits: [{ ...hit }] },
    { lane: 'keyword_en', family: 'keyword', hits: [{ ...hit }] },
  ]);
  assert.equal(fused.length, 1);
  assert.ok(Math.abs(fused[0].score - 1 / 61) < 1e-12);
});

test('matchOf: retrieval-only labels', () => {
  assert.equal(matchOf({ exact: true, lanes: {} }), 'exact');
  assert.equal(matchOf({ lanes: { keyword: { rank: 1 } } }), 'words');
  assert.equal(matchOf({ lanes: { keyword_en: { rank: 1 }, vector: { rank: 2 } } }), 'words_and_meaning');
  assert.equal(matchOf({ lanes: { vector_en: { rank: 1 } } }), 'meaning');
});

test('frameOf: rounds to the nearest frame and clamps to the sprite', () => {
  const meta = { cols: 10, rows: 4, count: 37, interval: 1, width: 96, height: 170 };
  assert.deepEqual(frameOf(meta, 0), { col: 0, row: 0 });
  assert.deepEqual(frameOf(meta, 12.5), { col: 3, row: 1 });
  assert.deepEqual(frameOf(meta, 999), { col: 6, row: 3 });
  assert.equal(frameOf(null, 3), null);
  assert.equal(frameOf({ ...meta, interval: 0 }, 3), null);
});

test('trimQuote: drops Content Understanding segment times', () => {
  assert.equal(
    trimQuote('00:00:00.110-00:00:01.550:Wie viele Ecken? 00:00:02.030-00:00:06.110: Responses shown.'),
    'Wie viele Ecken? Responses shown.',
  );
});

test('highlightParts: phrase and content words only; nothing for a meaning match', () => {
  assert.deepEqual(marked(highlightParts('The math exam was hard', 'math exam', 'exact')), ['math exam']);
  assert.deepEqual(marked(highlightParts('Uso cards para para estudar', 'peruca para crianças', 'words')), []);
  assert.deepEqual(marked(highlightParts('mathematics exam', 'math', 'words')), [], 'whole words only');
  assert.deepEqual(marked(highlightParts('The math exam', 'math exam', 'meaning')), []);
  assert.deepEqual(marked(highlightParts('テストの準備をする', 'テスト', 'words')), ['テスト']);
  assert.deepEqual(
    marked(highlightParts('She combs her hair in front of a mirror', ['se peina frente al espejo', 'combing hair in front of mirror'], 'words')),
    ['hair', 'front', 'mirror'],
  );
});

test('errorCopy: says what happened for each failure kind', () => {
  assert.match(errorCopy({ kind: 'rate' }), /Too many searches/);
  assert.match(errorCopy({ kind: 'offline' }), /offline/);
  assert.match(errorCopy({ kind: 'unavailable' }), /unavailable/);
  assert.equal(errorCopy({ kind: 'other', message: 'Bad filter.' }), 'Bad filter.');
  assert.equal(errorCopy(null), '');
});

test('search failure view stays safe when the error is cleared mid-retry', () => {
  assert.equal(searchFailureView(null).retry, true);
  assert.match(searchFailureView(null).message, /unavailable/);
  assert.equal(searchFailureView(undefined).retry, true);
  assert.equal(searchFailureView({ kind: 'offline' }).retry, false);
  assert.match(searchFailureView({ kind: 'offline' }).message, /offline/);

  const next = beginSearchState(
    { status: 'error', error: { kind: 'offline' }, results: [], phase: 'full' },
    'offline-only',
  );
  assert.equal(next.status, 'loading');
  assert.equal(next.error, null);
  assert.equal(next.busy, true);
  assert.equal(next.stale, false);

  const kept = beginSearchState({ status: 'done', error: null, results: [{ videoId: 'v001' }] }, 'again');
  assert.equal(kept.status, 'done');
  assert.equal(kept.stale, true);
  assert.equal(kept.error, null);
});

test('search URL state round-trips and drops unknown kinds', () => {
  const href = searchToUrl('http://localhost/?video=v002#top', {
    view: 'search',
    q: '  chica bailando ',
    filters: { lang: 'es', field: 'scene', account: 'sssteffff_' },
  });
  assert.equal(href, '/?video=v002&view=search&q=chica+bailando&lang=es&kind=scene&account=sssteffff_#top');
  assert.deepEqual(searchFromUrl(href), {
    view: 'search',
    q: 'chica bailando',
    filters: { lang: 'es', field: 'scene', account: 'sssteffff_' },
  });
  assert.equal(searchFromUrl('/?view=search&kind=activation').filters.field, '');
  assert.equal(searchToUrl('http://localhost/?view=search&q=x', { view: '', q: '', filters: {} }), '/');
});

test('result copy: why lines and counts', () => {
  assert.equal(whyLine({ kind: 'on_screen', tSec: 70 }), 'On screen at 1:10');
  assert.equal(whyLine({ kind: 'video', tSec: 0 }), 'About the whole video');
  const counts = resultCounts([{ momentCount: 3 }, { more: [{}] }]);
  assert.deepEqual(counts, { videos: 2, moments: 5 });
  assert.equal(countLine({ videos: 1, moments: 1 }), '1 video · 1 moment');
});
