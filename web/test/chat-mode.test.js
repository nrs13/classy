import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHAT_PAUSED, chatMode, chatStatus, matchCanned } from '../server/chat/mode.js';

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

test('a missing or invalid chat mode is off', () => {
  assert.equal(chatMode({}), 'off');
  assert.equal(chatMode({ CHAT_MODE: '  ' }), 'off');
  assert.equal(chatMode({ CHAT_MODE: 'sometimes' }), 'off');
  assert.equal(chatMode({ CHAT_MODE: 'LIVE' }), 'live');
  assert.equal(chatMode({ CHAT_MODE: 'canned' }), 'canned');
  assert.equal(chatStatus({ CHAT_MODE: 'live' }).ready, false);
  assert.equal(chatStatus({ CHAT_MODE: 'live', GEMINI_CHAT_API_KEY: 'present' }).ready, true);
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

test('a canned question matches only its clip', () => {
  const rows = [{ videoId: 'v002', question: 'How is amplification computed?', answer: 'plays divided by followers' }];
  assert.equal(
    matchCanned('How is amplification computed?', { ids: ['v002'] }, rows),
    'plays divided by followers',
  );
  assert.equal(matchCanned('How is amplification computed?', { ids: ['v014'] }, rows), null);
});
