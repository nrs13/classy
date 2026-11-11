/**
 * Route tests against a throwaway Postgres database with a fixture Library:
 * snapshot fx-live (pointer, 4-dim vectors) and fx-old (not live).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import pg from 'pg';

const DB = `classy_api_test_${process.pid}`;
const PROFILE = 'test|fake|4|document';
const schema = readFileSync(new URL('../../catalog/schema.sql', import.meta.url), 'utf8');

process.env.CLASSY_LOG = 'off';
process.env.DATABASE_URL = `postgresql:///${DB}`;
process.env.ANTHROPIC_API_KEY ||= 'test-key-not-used';

let admin;
let api;
let service;
let pool;

async function seed(client) {
  await client.query(schema);
  await client.query(`
    INSERT INTO snapshot (id, complete, embedding_model, embedding_dim, embedding_profile) VALUES
      ('fx-old', true, NULL, NULL, NULL),
      ('fx-live', true, 'fake', 4, '${PROFILE}');
    UPDATE pointer SET snapshot_id = 'fx-live' WHERE id = 1;
    INSERT INTO clip (video_id, snapshot_id, language, account, duration, curve, mp4_object, act_object, sprite_object, sprite_meta) VALUES
      ('v003', 'fx-old', 'en-US', 'gamma', 5, '[0.1]', 'snapshots/fx-old/v003.mp4', '', NULL, NULL),
      ('v001', 'fx-live', 'en-US', 'alpha', 10, '[0.1, 0.2]', 'snapshots/fx-live/v001.mp4', '',
       'snapshots/fx-live/v001.frames.jpg', '{"cols": 10, "rows": 1, "count": 10, "interval": 1, "width": 96, "height": 170}'),
      ('v002', 'fx-live', 'es-ES', 'beta', 8, '[0.3]', '', '', NULL, NULL);
    INSERT INTO second (video_id, snapshot_id, t_sec, speech, speaker, text_on_screen) VALUES
      ('v003', 'fx-old', 0, 'Old snapshot line.', '', '[]'),
      ('v001', 'fx-live', 0, 'We start the exam now.', 'Speaker #1', '[]'),
      ('v001', 'fx-live', 1, 'The math exam was hard.', 'Speaker #2', '[]'),
      ('v001', 'fx-live', 5, 'Then we celebrated.', 'Speaker #1', '[]'),
      ('v002', 'fx-live', 0, 'Hola a todos.', '', '[]'),
      ('v002', 'fx-live', 3, '', '', '[{"text": "SchoolGPT"}]');
    INSERT INTO chunk (video_id, snapshot_id, t_sec, field, text, embedding, dimension) VALUES
      ('v003', 'fx-old', 0, 'speech', 'Old snapshot line.', NULL, NULL),
      ('v001', 'fx-live', 1, 'speech', 'The math exam was hard.', '[1,0,0,0]', 4),
      ('v001', 'fx-live', 5, 'speech', 'Then we celebrated.', '[0,1,0,0]', 4),
      ('v002', 'fx-live', 0, 'speech', 'Hola a todos.', '[0,0,1,0]', 4),
      ('v002', 'fx-live', 3, 'text_on_screen', 'SchoolGPT', '[0,0,0,1]', 4),
      ('v002', 'fx-live', 0, 'activation', 'Visual Limbic', '[0.5,0.5,0.5,0.5]', 4);
  `);
}

before(async () => {
  admin = new pg.Client({ connectionString: 'postgresql:///postgres' });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
  await admin.query(`CREATE DATABASE ${DB}`);
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await seed(client);
  await client.end();
  api = {
    catalog: (await import('../api/catalog.js')).default,
    search: (await import('../api/search.js')).default,
    seconds: (await import('../api/seconds.js')).default,
    media: (await import('../api/media.js')).default,
    chat: (await import('../api/chat.js')).default,
  };
  service = await import('../server/search/service.js');
  pool = await import('../server/repo/pool.js');
});

after(async () => {
  await pool?.closePool();
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await admin.end();
});

let ipCounter = 0;

async function call(handler, { method = 'GET', url = '/', headers = {}, body } = {}) {
  ipCounter += 1;
  const req = { method, url, headers: { 'x-forwarded-for': `198.51.100.${ipCounter % 250}`, ...headers }, body };
  const res = {
    statusCode: 200,
    headers: {},
    chunks: [],
    body: undefined,
    headersSent: false,
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      this.headersSent = true;
    },
    writeHead(code, hdrs = {}) {
      this.statusCode = code;
      for (const [k, v] of Object.entries(hdrs)) this.setHeader(k, v);
      this.headersSent = true;
    },
    write(chunk) {
      this.chunks.push(String(chunk));
    },
    end(chunk) {
      if (chunk) this.chunks.push(String(chunk));
      this.headersSent = true;
    },
  };
  await handler(req, res);
  return res;
}

function sseText(res) {
  return res.chunks
    .join('')
    .split('\n\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)))
    .filter((event) => event.type === 'text')
    .map((event) => event.text)
    .join('');
}

test('catalog serves the pointer snapshot only, with an ETag', async () => {
  const res = await call(api.catalog, { url: '/api/catalog' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.snapshotId, 'fx-live');
  assert.deepEqual(
    res.body.videos.map((v) => v.id).sort(),
    ['v001', 'v002'],
  );
  assert.ok(res.headers['x-request-id']);
  const again = await call(api.catalog, { url: '/api/catalog', headers: { 'if-none-match': res.headers.etag } });
  assert.equal(again.statusCode, 304);
});

test('seconds: ids outside the snapshot or not starting with v are not found', async () => {
  assert.equal((await call(api.seconds, { url: '/api/seconds?id=v001' })).statusCode, 200);
  for (const id of ['v003', 'abc', '../etc/passwd', 'v1;DROP', '']) {
    const res = await call(api.seconds, { url: `/api/seconds?id=${encodeURIComponent(id)}` });
    assert.equal(res.statusCode, 404, id);
    assert.equal(res.body.message, 'That video is not in your Library.');
  }
});

test('search: empty query returns no results and examples on request', async () => {
  const res = await call(api.search, { url: '/api/search?q=&examples=1' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.results, []);
  assert.ok(Array.isArray(res.body.examples));
});

test('search: profile mismatch falls back to exact matches with a notice', async () => {
  const res = await call(api.search, { url: '/api/search?q=SchoolGPT' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.mode, 'exact');
  assert.equal(res.body.notice, service.EXACT_NOTICE);
  assert.equal(res.body.results[0].videoId, 'v002');
  assert.equal(res.body.results[0].best.kind, 'on_screen');
  assert.equal(res.body.results[0].best.strength, 'strong');
  assert.match(res.headers['server-timing'], /total;dur=/);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.body.timing, undefined);
});

test('search: a quoted phrase is exact only and has no notice', async () => {
  const res = await call(api.search, { url: `/api/search?q=${encodeURIComponent('"math exam"')}` });
  assert.equal(res.body.notice, null);
  assert.deepEqual(
    res.body.results.map((r) => r.videoId),
    ['v001'],
  );
});

test('search: never returns brain-network labels or another snapshot', async () => {
  const visual = await call(api.search, { url: '/api/search?q=Visual%20Limbic' });
  assert.deepEqual(visual.body.results, []);
  const old = await call(api.search, { url: '/api/search?q=Old%20snapshot' });
  assert.deepEqual(old.body.results, []);
});

test('search: invalid filters are a safe 400', async () => {
  for (const qs of ['q=x&field=activation', 'q=x&lang=english']) {
    const res = await call(api.search, { url: `/api/search?${qs}` });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(Object.keys(res.body).sort(), ['error', 'message', 'requestId']);
  }
  const post = await call(api.search, { method: 'POST', url: '/api/search?q=x' });
  assert.equal(post.statusCode, 405);
});

test('search: rate limited per client', async () => {
  const headers = { 'x-forwarded-for': '192.0.2.77' };
  let last;
  for (let i = 0; i < 61; i += 1) {
    last = await call(api.search, { url: '/api/search?q=hola', headers });
  }
  assert.equal(last.statusCode, 429);
  assert.equal(last.body.error, 'rate_limited');
});

test('service: hybrid when profiles match; speaker only with several speakers', async () => {
  const provider = {
    name: 'fake',
    profile: PROFILE,
    queryModel: 'fake-q',
    configured: true,
    embedQuery: async () => [1, 0, 0, 0],
  };
  const body = await service.searchLibrary({ q: 'difficult mathematics test', provider, understand: false });
  assert.equal(body.mode, 'hybrid');
  assert.equal(body.notice, null);
  assert.equal(body.results[0].videoId, 'v001');
  assert.equal(body.results[0].best.tSec, 1);
  assert.equal(body.results[0].best.speaker, 'Speaker #2');
  assert.equal(body.results[0].best.before, 'We start the exam now.');
  assert.equal(body.results[0].best.match, 'meaning');
  assert.deepEqual(body.results[0].best.frame, { col: 1, row: 0 });
  assert.equal(body.results[0].sprite.url, '/api/media?kind=sprite&id=v001');
  assert.equal(body.understanding, undefined);
});

test('service: embedding failure keeps keyword matches and says so', async () => {
  const provider = {
    name: 'fake',
    profile: PROFILE,
    queryModel: 'fake-q',
    configured: true,
    embedQuery: async () => {
      throw new Error('embedding_http_503');
    },
  };
  const body = await service.searchLibrary({ q: 'SchoolGPT again', provider, understand: false });
  assert.equal(body.mode, 'exact');
  assert.equal(body.notice, service.KEYWORD_NOTICE);
  assert.ok(Array.isArray(body.results));
});

test('service: a failed rerank keeps the keyword list', async () => {
  const body = await service.searchLibrary({
    q: 'SchoolGPT again',
    understand: false,
    mode: 'exact',
    reranker: { name: 'boom', rerank: async () => { throw new Error('rerank down'); } },
  });
  assert.equal(body.notice, service.KEYWORD_NOTICE);
  assert.ok(Array.isArray(body.results));
});

test('service: mode=exact skips the vector lane without a notice', async () => {
  const provider = {
    name: 'fake',
    profile: PROFILE,
    queryModel: 'fake-q',
    configured: true,
    embedQuery: async () => assert.fail('should not embed'),
  };
  const body = await service.searchLibrary({ q: 'math', mode: 'exact', provider });
  assert.equal(body.mode, 'exact');
  assert.equal(body.notice, null);
});

test('media: bad kind is 400, unknown video is 404', async () => {
  assert.equal((await call(api.media, { url: '/api/media?id=v001&kind=zip' })).statusCode, 400);
  assert.equal((await call(api.media, { url: '/api/media?id=v999&kind=mp4' })).statusCode, 404);
  assert.equal((await call(api.media, { url: '/api/media?id=v003&kind=mp4' })).statusCode, 404);
  assert.equal((await call(api.media, { url: '/api/media?id=v002&kind=sprite' })).statusCode, 404);
});

test('media: a sprite redirects to a signed object URL that can be cached briefly', async () => {
  const res = await call(api.media, { url: '/api/media?id=v001&kind=sprite' });
  assert.equal(res.statusCode, 302);
  assert.match(res.headers.location, /^\/api\/object\?token=/);
  assert.match(res.headers['cache-control'], /^private, max-age=\d+$/);
  const mp4 = await call(api.media, { url: '/api/media?id=v001&kind=mp4' });
  assert.equal(mp4.statusCode, 200);
  assert.equal(mp4.headers['cache-control'], 'private, no-store');
});

test('a live 429 falls back to the paused line when nothing is stored', async () => {
  const prevMode = process.env.CHAT_MODE;
  const prevProvider = process.env.CHAT_PROVIDER;
  const prevKey = process.env.GEMINI_CHAT_API_KEY;
  process.env.CHAT_MODE = 'live';
  process.env.CHAT_PROVIDER = 'gemini';
  process.env.GEMINI_CHAT_API_KEY = 'test-gemini-key';
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 429,
    async text() {
      return 'RESOURCE_EXHAUSTED';
    },
  });
  try {
    const res = await call(api.chat, {
      method: 'POST',
      url: '/api/chat',
      headers: { 'x-vercel-ip-country': 'US' },
      body: { message: 'What can this clip not tell us?', focus: { ids: ['v002'], timeSec: 0 } },
    });
    assert.equal(sseText(res), 'Chat is paused in this demo.');
  } finally {
    globalThis.fetch = original;
    if (prevMode === undefined) delete process.env.CHAT_MODE;
    else process.env.CHAT_MODE = prevMode;
    if (prevProvider === undefined) delete process.env.CHAT_PROVIDER;
    else process.env.CHAT_PROVIDER = prevProvider;
    if (prevKey === undefined) delete process.env.GEMINI_CHAT_API_KEY;
    else process.env.GEMINI_CHAT_API_KEY = prevKey;
  }
});

test('chat refuses videos that are not open or not in the Library', async () => {
  const prev = process.env.CHAT_PROVIDER;
  const prevMode = process.env.CHAT_MODE;
  process.env.CHAT_PROVIDER = 'anthropic';
  process.env.CHAT_MODE = 'live';
  try {
  const none = await call(api.chat, { method: 'POST', url: '/api/chat', headers: { 'x-vercel-ip-country': 'US' }, body: { message: 'What is open right now?', focus: null } });
  assert.equal(sseText(none), 'Open a video first.');
  for (const ids of [['v003'], ['x1'], ['v001', '../v002']]) {
    const res = await call(api.chat, { method: 'POST', url: '/api/chat', headers: { 'x-vercel-ip-country': 'US' }, body: { message: 'What is open right now?', focus: { ids, timeSec: 0 } } });
    assert.equal(sseText(res), 'That video is not in your Library.', ids.join(','));
  }
  const empty = await call(api.chat, { method: 'POST', url: '/api/chat', body: { message: '  ' } });
  assert.equal(empty.statusCode, 400);
  } finally {
    if (prev === undefined) delete process.env.CHAT_PROVIDER;
    else process.env.CHAT_PROVIDER = prev;
    if (prevMode === undefined) delete process.env.CHAT_MODE;
    else process.env.CHAT_MODE = prevMode;
  }
});
