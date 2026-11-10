import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHAT_PRIVACY } from '../src/lib/ai.js';
import { CHAT_PAUSED, chatMode, chatStatus, liveFallbackText, matchCanned } from '../server/chat/mode.js';

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

test('the live privacy note uses the unpaid-services wording', () => {
  assert.match(CHAT_PRIVACY, /Google's Gemini API/);
  assert.match(
    CHAT_PRIVACY,
    /provide, improve, and develop Google products and services and machine learning technologies/,
  );
  assert.equal(chatStatus({ CHAT_MODE: 'live', GEMINI_CHAT_API_KEY: 'present' }).privacy, true);
  assert.equal(chatStatus({ CHAT_MODE: 'canned' }).privacy, false);
  assert.equal(chatStatus({ CHAT_MODE: 'off' }).privacy, false);
});

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
