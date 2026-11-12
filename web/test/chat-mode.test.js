import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHAT_PRIVACY } from '../src/lib/ai.js';
import {
  CHAT_PAUSED,
  REGION_CANNED_NOTICE,
  chatMode,
  chatStatus,
  liveFallbackText,
  matchCanned,
} from '../server/chat/mode.js';

process.env.CLASSY_LOG = 'off';

function sseCapture() {
  let raw = '';
  return {
    headers: {},
    statusCode: 200,
    body: undefined,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    writeHead() {},
    write(chunk) {
      raw += chunk;
    },
    end() {
      this.raw = raw;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
    },
  };
}

test('the live privacy note names a service provider and asks for no personal information', () => {
  assert.equal(
    CHAT_PRIVACY,
    "Questions you type here are processed by a service provider to generate answers. Please don't enter personal information.",
  );
  assert.equal(chatStatus({ CHAT_MODE: 'live', GEMINI_CHAT_API_KEY: 'present' }, 'US').privacy, true);
  assert.equal(chatStatus({ CHAT_MODE: 'live', GEMINI_CHAT_API_KEY: 'present' }, 'FR').privacy, false);
  assert.equal(chatStatus({ CHAT_MODE: 'canned' }).privacy, false);
  assert.equal(chatStatus({ CHAT_MODE: 'off' }).privacy, false);
});

test('a missing or invalid chat mode is off', () => {
  assert.equal(chatMode({}), 'off');
  assert.equal(chatMode({ CHAT_MODE: '  ' }), 'off');
  assert.equal(chatMode({ CHAT_MODE: 'sometimes' }), 'off');
  assert.equal(chatMode({ CHAT_MODE: 'LIVE' }), 'live');
  assert.equal(chatMode({ CHAT_MODE: 'canned' }), 'canned');
  assert.equal(chatStatus({ CHAT_MODE: 'live' }, 'US').ready, false);
  assert.equal(chatStatus({ CHAT_MODE: 'live' }).mode, 'canned');
  assert.equal(chatStatus({ CHAT_MODE: 'live', GEMINI_CHAT_API_KEY: 'present' }, 'US').ready, true);
  assert.equal(chatStatus({ CHAT_MODE: 'canned' }).ready, true);
  assert.equal(chatStatus({}).privacy, false);
});

test('chat mode off does not call a model', async () => {
  const prev = process.env.CHAT_MODE;
  delete process.env.CHAT_MODE;
  const handler = (await import('../api/chat.js')).default;
  const res = sseCapture();
  await handler({ method: 'GET', headers: {}, url: '/api/chat' }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.mode, 'off');
  assert.equal(res.body.ready, false);
  assert.equal(res.headers['cache-control'], 'no-store');

  const post = sseCapture();
  await handler(
    { method: 'POST', headers: {}, url: '/api/chat', body: { message: 'Why is this clip different?' } },
    post,
  );
  assert.match(post.raw, new RegExp(CHAT_PAUSED.replace(/[.]/g, '\\.')));
  assert.equal(post.raw.includes('data: {"type":"meta"'), false);
  if (prev === undefined) delete process.env.CHAT_MODE;
  else process.env.CHAT_MODE = prev;
});

test('canned mode answers from storage and does not call a model', async () => {
  const prev = process.env.CHAT_MODE;
  process.env.CHAT_MODE = 'canned';
  const handler = (await import('../api/chat.js')).default;
  const res = sseCapture();
  await handler(
    {
      method: 'POST',
      headers: {},
      url: '/api/chat',
      body: { message: 'a question that is not stored', focus: { ids: ['v002'] } },
    },
    res,
  );
  assert.match(res.raw, /Only the suggested questions are answered in this demo/);
  if (prev === undefined) delete process.env.CHAT_MODE;
  else process.env.CHAT_MODE = prev;
});

test('a restricted country, and a missing country, keep live chat canned', async () => {
  const prevMode = process.env.CHAT_MODE;
  const prevKey = process.env.GEMINI_CHAT_API_KEY;
  process.env.CHAT_MODE = 'live';
  process.env.GEMINI_CHAT_API_KEY = 'present';
  const handler = (await import('../api/chat.js')).default;
  const cases = [
    ['FR', 'canned', false, REGION_CANNED_NOTICE],
    ['GB', 'canned', false, REGION_CANNED_NOTICE],
    ['CH', 'canned', false, REGION_CANNED_NOTICE],
    ['NP', 'live', true, ''],
    ['US', 'live', true, ''],
    ['', 'canned', false, REGION_CANNED_NOTICE],
  ];
  try {
    for (const [country, mode, privacy, notice] of cases) {
      const headers = country ? { 'x-vercel-ip-country': country } : {};
      const res = sseCapture();
      await handler({ method: 'GET', headers, url: '/api/chat' }, res);
      assert.equal(res.body.mode, mode, country || 'missing');
      assert.equal(res.body.privacy, privacy, country || 'missing');
      assert.equal(res.body.notice, notice, country || 'missing');
      assert.equal(res.body.ready, true, country || 'missing');
    }
    const post = sseCapture();
    let called = false;
    const original = globalThis.fetch;
    globalThis.fetch = async () => {
      called = true;
      return { ok: true, status: 200, body: null };
    };
    try {
      await handler(
        {
          method: 'POST',
          headers: { 'x-vercel-ip-country': 'FR' },
          url: '/api/chat',
          body: { message: 'a question that is not stored', focus: { ids: ['v002'] } },
        },
        post,
      );
    } finally {
      globalThis.fetch = original;
    }
    assert.equal(called, false);
    assert.match(post.raw, /Only the suggested questions are answered in this demo/);
    assert.equal(chatStatus({ CHAT_MODE: 'off' }, 'FR').mode, 'off');
    assert.equal(chatStatus({ CHAT_MODE: 'off' }).notice, '');
    assert.equal(chatStatus({ CHAT_MODE: 'canned' }, 'GB').notice, '');
  } finally {
    if (prevMode === undefined) delete process.env.CHAT_MODE;
    else process.env.CHAT_MODE = prevMode;
    if (prevKey === undefined) delete process.env.GEMINI_CHAT_API_KEY;
    else process.env.GEMINI_CHAT_API_KEY = prevKey;
  }
});

test('a live provider failure uses a stored answer, otherwise the paused line', () => {
  const rows = [{ videoId: 'v002', question: 'How did this clip grow?', answer: 'Stored from the clip card.' }];
  const focus = { ids: ['v002'] };
  for (const errorType of ['quota', 'auth', 'timeout', 'server', 'missing_key']) {
    assert.equal(liveFallbackText(errorType, 'How did this clip grow?', focus, rows), 'Stored from the clip card.');
    assert.equal(liveFallbackText(errorType, 'Tell me a secret.', focus, rows), CHAT_PAUSED);
  }
  assert.equal(liveFallbackText('api', 'How did this clip grow?', focus, rows), null);
});

test('the stored v002 answers match the suggested questions', () => {
  const question = 'How is amplification computed for v002? Show the numbers (31,300,000 plays / 5,750 followers).';
  const answer = matchCanned(question, { ids: ['v002'] });
  assert.match(answer, /31,300,000/);
  assert.match(answer, /5,750/);
  assert.equal(matchCanned(question, { ids: ['v014'] }), null);
});

test('a canned question matches only its clip', () => {
  const rows = [{ videoId: 'v002', question: 'How is amplification computed?', answer: 'plays divided by followers' }];
  assert.equal(
    matchCanned('How is amplification computed?', { ids: ['v002'] }, rows),
    'plays divided by followers',
  );
  assert.equal(matchCanned('How is amplification computed?', { ids: ['v014'] }, rows), null);
});

test('a typed question is answered by the model', async () => {
  const prev = {
    mode: process.env.CHAT_MODE,
    provider: process.env.CHAT_PROVIDER,
    node: process.env.NODE_ENV,
    vercel: process.env.VERCEL_ENV,
  };
  process.env.CHAT_MODE = 'live';
  process.env.CHAT_PROVIDER = 'mock';
  process.env.NODE_ENV = 'test';
  delete process.env.VERCEL_ENV;
  const mockChat = await import('../server/chat/mock.js');
  mockChat.resetMockStarts();
  try {
    const handler = (await import('../api/chat.js')).default;
    const res = sseCapture();
    await handler({
      method: 'POST',
      url: '/api/chat',
      headers: { 'x-vercel-ip-country': 'US' },
      body: {
        message: 'explain this clip to me as I am new to it',
        history: [{ role: 'assistant', text: 'A shorter first try.' }],
        focus: { ids: ['v002'], timeSec: 0 },
      },
    }, res);
    assert.equal(mockChat.mockStarts, 1);
    assert.match(res.raw || '', /This is a mock answer/);
    assert.equal((res.raw || '').includes('Breakout is the tier on the clip card'), false);
  } finally {
    if (prev.mode === undefined) delete process.env.CHAT_MODE;
    else process.env.CHAT_MODE = prev.mode;
    if (prev.provider === undefined) delete process.env.CHAT_PROVIDER;
    else process.env.CHAT_PROVIDER = prev.provider;
    if (prev.node === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prev.node;
    if (prev.vercel === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = prev.vercel;
  }
});

test('a live exact suggested question returns the stored answer and does not call the model', async () => {
  const prev = {
    mode: process.env.CHAT_MODE,
    provider: process.env.CHAT_PROVIDER,
    key: process.env.GEMINI_CHAT_API_KEY,
  };
  process.env.CHAT_MODE = 'live';
  process.env.CHAT_PROVIDER = 'gemini';
  delete process.env.GEMINI_CHAT_API_KEY;
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error('model should not be called');
  };
  try {
    const handler = (await import('../api/chat.js')).default;
    const questions = [
      ['What are the biggest caveats of this analysis at N=97?', /The pack is 97 videos/],
      ["v002's Visual lead over Dorsal Attention is wide (0.1260 vs 0.0697). What do ranks 2 and 3 add beyond the baseline?", /Somatomotor at 0\.0664/],
    ];
    for (const [message, pattern] of questions) {
      const res = sseCapture();
      await handler({
        method: 'POST',
        url: '/api/chat',
        headers: { 'x-vercel-ip-country': 'US' },
        body: { message, focus: { ids: ['v002'], timeSec: 1 } },
      }, res);
      assert.match(res.raw || '', pattern);
    }
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = original;
    if (prev.mode === undefined) delete process.env.CHAT_MODE;
    else process.env.CHAT_MODE = prev.mode;
    if (prev.provider === undefined) delete process.env.CHAT_PROVIDER;
    else process.env.CHAT_PROVIDER = prev.provider;
    if (prev.key === undefined) delete process.env.GEMINI_CHAT_API_KEY;
    else process.env.GEMINI_CHAT_API_KEY = prev.key;
  }
});
