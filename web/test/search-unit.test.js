import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.CLASSY_LOG = 'off';

const { parseQuery, substringWorthy, containsWholeWords, MAX_QUERY_CHARS } = await import(
  '../server/search/query.js'
);
const { fuseRanks, markExact, collapseMoments, groupByVideo, FIELD_WEIGHTS, RRF_K } = await import(
  '../server/search/rank.js'
);
const { strengthOf, contextLines, explainMoment, kindOf, trimQuote, repeatsQuote } = await import(
  '../server/search/explain.js'
);
const { keywordLane, vectorLane } = await import('../server/search/retrieve.js');
const { createQueryCache } = await import('../server/providers/embedding/index.js');
const { createVoyageProvider } = await import('../server/providers/embedding/voyage.js');
const { createGeminiRerank } = await import('../server/providers/rerank/gemini.js');
const { route, rateLimit } = await import('../server/http.js');
const { AppError } = await import('../server/obs/errors.js');

function hit(videoId, tSec, field = 'speech', text = `${videoId}@${tSec}`, extra = {}) {
  return { id: `${videoId}-${tSec}-${field}`, videoId, tSec, field, text, score: 1, ...extra };
}

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    headersSent: false,
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      this.headersSent = true;
    },
    end() {
      this.headersSent = true;
    },
  };
}

test('parseQuery: wholly quoted queries are exact only', () => {
  const p = parseQuery('  "Corea del Norte"  ');
  assert.equal(p.exactOnly, true);
  assert.equal(p.phrase, 'Corea del Norte');
  assert.equal(p.normalized, 'corea del norte');
  assert.equal(parseQuery('say "hi" there').exactOnly, false);
  assert.equal(parseQuery('“curly quotes”').exactOnly, true);
});

test('parseQuery: caps length and validates filters', () => {
  assert.equal(parseQuery('a'.repeat(400)).text.length, MAX_QUERY_CHARS);
  assert.deepEqual(parseQuery('x', { lang: 'ES', field: 'said', account: 'acct' }).filters, {
    lang: 'es',
    kind: 'said',
    account: 'acct',
  });
  assert.throws(() => parseQuery('x', { lang: 'spanish' }), AppError);
  assert.throws(() => parseQuery('x', { field: 'activation' }), AppError);
  assert.throws(() => parseQuery('x', { account: 'a'.repeat(65) }), AppError);
});

test('substringWorthy: short Latin no, short CJK yes', () => {
  assert.equal(substringWorthy('ai'), false);
  assert.equal(substringWorthy('math'), true);
  assert.equal(substringWorthy('勉強'), true);
});

test('fuseRanks: plain RRF with k=60 and no field weights by default', () => {
  assert.equal(RRF_K, 60);
  assert.deepEqual(FIELD_WEIGHTS, {});
  const a = hit('v1', 0);
  const b = hit('v2', 0);
  const fused = fuseRanks([
    { lane: 'keyword', hits: [a, b] },
    { lane: 'vector', hits: [b] },
  ]);
  assert.equal(fused[0].videoId, 'v2');
  assert.ok(Math.abs(fused[0].score - (1 / 62 + 1 / 61)) < 1e-12);
  assert.deepEqual(Object.keys(fused[0].lanes).sort(), ['keyword', 'vector']);
});

test('markExact and groupByVideo keep whole-query hits on top', () => {
  const exact = markExact([hit('v9', 3, 'text_on_screen', 'SchoolGPT')], 'schoolgpt');
  assert.equal(exact[0].exact, true);
  assert.equal(markExact([hit('v8', 0, 'text_on_screen', 'EXAMEN,')], 'exam')[0].exact, undefined);
  assert.equal(markExact([hit('v8', 0, 'speech', 'the AI app')], 'ai')[0].exact, true);
  const fused = fuseRanks([
    { lane: 'vector', hits: [hit('v1', 0), hit('v2', 0)] },
    { lane: 'keyword', hits: exact },
  ]);
  const groups = groupByVideo(collapseMoments(fused));
  assert.equal(groups[0].videoId, 'v9');
});

test('collapseMoments merges hits under 3 seconds apart in one video', () => {
  const fused = fuseRanks([{ lane: 'keyword', hits: [hit('v1', 10), hit('v1', 11), hit('v1', 20), hit('v2', 10)] }]);
  const moments = collapseMoments(fused);
  assert.deepEqual(
    moments.map((m) => `${m.videoId}@${m.tSec}`),
    ['v1@10', 'v1@20', 'v2@10'],
  );
  assert.equal(moments[0].alsoMatched, 1);
});

test('groupByVideo keeps at most three moments per video', () => {
  const fused = fuseRanks([{ lane: 'keyword', hits: [0, 5, 10, 15, 20].map((t) => hit('v1', t)) }]);
  assert.equal(groupByVideo(collapseMoments(fused))[0].moments.length, 3);
});

test('strength is retrieval strength only', () => {
  assert.equal(strengthOf({ exact: true, lanes: {} }), 'strong');
  assert.equal(strengthOf({ lanes: { keyword: { rank: 9 }, vector: { rank: 30 } } }), 'strong');
  assert.equal(strengthOf({ lanes: { vector: { rank: 2, score: 0.3 } } }), 'good');
  assert.equal(strengthOf({ lanes: { vector: { rank: 30, score: 0.2 } } }), 'partial');
  assert.equal(strengthOf({ lanes: { vector: { rank: 12, videoRank: 2, relative: 0.8 } } }), 'good');
  assert.equal(strengthOf({ lanes: { vector: { rank: 40, videoRank: 9, relative: 0.95 } } }), 'good');
  assert.equal(strengthOf({ lanes: { vector: { rank: 40, videoRank: 9, relative: 0.8 } } }), 'partial');
});

test('fuseRanks records video rank and relative score per lane', () => {
  const fused = fuseRanks([
    {
      lane: 'vector',
      hits: [hit('v1', 0, 'speech', 'a', { score: 0.6 }), hit('v1', 5, 'speech', 'b', { score: 0.59 }), hit('v2', 0, 'speech', 'c', { score: 0.3 })],
    },
  ]);
  const v2 = fused.find((h) => h.videoId === 'v2');
  assert.equal(v2.lanes.vector.rank, 3);
  assert.equal(v2.lanes.vector.videoRank, 2);
  assert.equal(v2.lanes.vector.relative, 0.5);
});

test('kinds map fields to said, on_screen and scene', () => {
  assert.equal(kindOf('segment'), 'said');
  assert.equal(kindOf('text_on_screen'), 'on_screen');
  assert.equal(kindOf('evidence'), 'scene');
});

test('contextLines prefers stored context, else nearby speech', () => {
  assert.deepEqual(contextLines({ tSec: 5, text: 'x', context: { before: 'a', after: 'b' } }), {
    before: 'a',
    after: 'b',
  });
  const window = [
    { t_sec: 2, speech: 'First line. Second line.' },
    { t_sec: 5, speech: 'The match.' },
    { t_sec: 8, speech: 'After that. More.' },
    { t_sec: 30, speech: 'Too far.' },
  ];
  assert.deepEqual(contextLines({ tSec: 5, text: 'The match.' }, window), {
    before: 'Second line.',
    after: 'After that.',
  });
});

test('context lines that the quote already shows are dropped', () => {
  const quote = "Je pense que tu connais le mieux entre l'histoire ou la Scribiditante à fruit. Première question pour l'histoire.";
  const moment = {
    tSec: 29,
    text: quote,
    context: { before: "Je pense que tu connais le mieux entre l'histoire ou la", after: 'Marono. Et enfin.' },
  };
  assert.deepEqual(contextLines(moment), { before: '', after: 'Marono. Et enfin.' });
  assert.equal(repeatsQuote('Ha ha ha.', 'exam season'), false);
});

test('speaker shows only when the video has more than one', () => {
  const moment = { tSec: 1, field: 'speech', text: 'hi', speaker: 'Speaker #2', lanes: {} };
  assert.equal(explainMoment(moment, { speakers: 1 }).speaker, null);
  assert.equal(explainMoment(moment, { speakers: 2 }).speaker, 'Speaker #2');
});

test('trimQuote cuts long text on a word boundary', () => {
  const out = trimQuote('word '.repeat(100), 50);
  assert.ok(out.endsWith('…'));
  assert.ok(out.length <= 51);
});

test('keywordLane: substring hits first, relaxed only when strict is thin', async () => {
  const calls = [];
  const repo = {
    async substringCandidates({ text }) {
      calls.push(['substring', text]);
      return [hit('v1', 0, 'text_on_screen', 'how was the math exam?')];
    },
    async keywordCandidates({ relaxed }) {
      calls.push([relaxed ? 'relaxed' : 'strict']);
      return relaxed ? [hit('v3', 0)] : [hit('v2', 0), hit('v9', 0, 'activation')];
    },
  };
  const parsed = parseQuery('how was the math exam');
  const hits = await keywordLane({ snapshotId: 's', parsed, repo });
  assert.deepEqual(
    hits.map((h) => h.videoId),
    ['v1', 'v2', 'v3'],
  );
  assert.equal(hits[0].exact, true);
  assert.ok(calls.some(([name]) => name === 'relaxed'));
});

test('containsWholeWords: word boundaries in Latin scripts, plain containment in CJK', () => {
  assert.equal(containsWholeWords('Mock Exam', 'exam'), true);
  assert.equal(containsWholeWords('examples', 'exam'), false);
  assert.equal(containsWholeWords('¿Cuándo es tu examen?', 'examen'), true);
  assert.equal(containsWholeWords('Mathearbeit', 'arbeit'), false);
  assert.equal(containsWholeWords('数学のテスト', '数学'), true);
  assert.equal(containsWholeWords('a (b) c', '(b)'), true);
});

test('keywordLane: a match inside a longer word ranks after whole-word matches', async () => {
  const repo = {
    async substringCandidates() {
      return [hit('v1', 0, 'text_on_screen', 'examples'), hit('v2', 0, 'text_on_screen', 'Mock Exam')];
    },
    async keywordCandidates({ relaxed }) {
      return relaxed ? [] : [hit('v3', 0, 'speech', 'the exam was hard'), hit('v4', 0), hit('v5', 0), hit('v6', 0), hit('v7', 0)];
    },
  };
  const hits = await keywordLane({ snapshotId: 's', parsed: parseQuery('exam'), repo });
  assert.deepEqual(
    hits.map((h) => h.videoId),
    ['v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v1'],
  );
});

test('keywordLane: a quoted query never relaxes', async () => {
  const calls = [];
  const repo = {
    async substringCandidates({ text }) {
      calls.push(['substring', text]);
      return [];
    },
    async keywordCandidates({ text, relaxed }) {
      calls.push([relaxed ? 'relaxed' : 'strict', text]);
      return [];
    },
  };
  await keywordLane({ snapshotId: 's', parsed: parseQuery('"exact words here"'), repo });
  assert.deepEqual(calls, [
    ['substring', 'exact words here'],
    ['strict', '"exact words here"'],
  ]);
});

test('vectorLane drops fields that are not lines anyone said or saw', async () => {
  const repo = { vectorCandidates: async () => [hit('v1', 0, 'keyword'), hit('v2', 0, 'scene')] };
  const hits = await vectorLane({ snapshot: { id: 's', embeddingDim: 4 }, parsed: parseQuery('x y'), vector: [1], repo });
  assert.deepEqual(
    hits.map((h) => h.videoId),
    ['v2'],
  );
});

test('query vector cache is an LRU', () => {
  const cache = createQueryCache(2);
  cache.set('a', 1);
  cache.set('b', 2);
  cache.get('a');
  cache.set('c', 3);
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.size, 2);
});

test('voyage provider: query input type, lite model, unit vectors', async () => {
  let body;
  const provider = createVoyageProvider(
    { VOYAGE_API_KEY: 'k' },
    {
      dim: 4,
      fetch: async (_url, init) => {
        body = JSON.parse(init.body);
        return { ok: true, json: async () => ({ data: [{ index: 0, embedding: [2, 0, 0, 0] }] }) };
      },
    },
  );
  const vector = await provider.embedQuery('  hola   mundo ');
  assert.deepEqual(vector, [1, 0, 0, 0]);
  assert.equal(body.input_type, 'query');
  assert.equal(body.model, 'voyage-4-lite');
  assert.deepEqual(body.input, ['hola mundo']);
  assert.equal(body.output_dimension, 4);
});

test('voyage provider: HTTP failure and missing key throw', async () => {
  const failing = createVoyageProvider({ VOYAGE_API_KEY: 'k' }, { fetch: async () => ({ ok: false, status: 503 }) });
  await assert.rejects(failing.embedQuery('x'), /embedding_http_503/);
  await assert.rejects(createVoyageProvider({}).embedQuery('x'), /embedding_not_configured/);
  assert.equal(createVoyageProvider({}).configured, false);
});

test('gemini rerank returns the input unchanged when the call fails', async () => {
  const items = [{ best: { quote: 'a' } }, { best: { quote: 'b' } }];
  const rerank = createGeminiRerank({ GEMINI_API_KEY: 'k' }, { fetch: async () => { throw new Error('down'); } });
  assert.equal(await rerank.rerank('q', items), items);
});

test('route: request id, method check, safe errors', async () => {
  const ok = route('t', {}, async (_req, res, { requestId }) => res.status(200).json({ requestId }));
  let res = fakeRes();
  await ok({ method: 'GET', headers: { 'x-request-id': 'abcdefgh1234' } }, res);
  assert.equal(res.headers['x-request-id'], 'abcdefgh1234');
  assert.equal(res.body.requestId, 'abcdefgh1234');

  res = fakeRes();
  await ok({ method: 'DELETE', headers: {} }, res);
  assert.equal(res.statusCode, 405);

  const boom = route('t', { fallback: 'search_unavailable' }, async () => {
    throw new Error('password=hunter2 at db.internal:5432');
  });
  res = fakeRes();
  await boom({ method: 'GET', headers: {} }, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, 'search_unavailable');
  assert.equal(res.body.message, 'Search is unavailable. Try again in a moment.');
  assert.ok(!JSON.stringify(res.body).includes('hunter2'));
});

test('rateLimit throws 429 past the window budget', () => {
  const req = { headers: { 'x-forwarded-for': '203.0.113.9' } };
  for (let i = 0; i < 3; i += 1) rateLimit(req, { name: 'unit', max: 3, windowMs: 60_000 });
  assert.throws(() => rateLimit(req, { name: 'unit', max: 3, windowMs: 60_000 }), (err) => err.status === 429);
});
