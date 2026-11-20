import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptSend, capMessage, composerHold, dropUnfinishedReply, MAX_CHAT_BODY_BYTES, MAX_MESSAGE_CHARS, messageLength, messageTooLong, retryTurn } from '../src/lib/chatLimits.js';

process.env.CLASSY_LOG = 'off';

test('a second send is refused while one reply is in flight', () => {
  assert.equal(acceptSend(false, 'hello there'), true);
  assert.equal(acceptSend(true, 'hello there'), false);
  assert.equal(acceptSend(false, '   '), false);
  assert.equal(acceptSend(false, ''), false);
  assert.equal(acceptSend(false, 'short'), false);
  assert.equal(acceptSend(false, 'why', 0, 0, [{ role: 'user', text: 'how many plays does this have?' }]), true);
  assert.equal(acceptSend(false, 'why', 10_000, 9_000, [{ role: 'user', text: 'how many plays does this have?' }]), false);
  assert.equal(composerHold({ text: 'why', history: [{ role: 'user', text: 'how many plays does this have?' }] }), '');
  assert.equal(acceptSend(false, 'hello there', 10_000, 9_000), false);
  assert.equal(acceptSend(false, 'hello there', 20_000, 9_000), true);
  assert.equal(composerHold({ text: 'hi' }), 'Type at least 8 characters.');
  assert.equal(composerHold({ text: 'hello there', cooldownLeft: 2 }), 'You can send again in 2 s');
  assert.equal(composerHold({ quotaText: 'You can send again in 40 s', cooldownLeft: 2 }), 'You can send again in 40 s');
  assert.equal(composerHold({ text: '' }), '');
});

test('the client cap matches 4000 code points and does not split an emoji', () => {
  assert.equal(messageLength('x'.repeat(MAX_MESSAGE_CHARS)), MAX_MESSAGE_CHARS);
  assert.equal(messageTooLong('x'.repeat(MAX_MESSAGE_CHARS)), false);
  assert.equal(messageTooLong(` ${'x'.repeat(MAX_MESSAGE_CHARS)} `), false);
  assert.equal(messageTooLong('x'.repeat(MAX_MESSAGE_CHARS + 1)), true);
  const emoji = '🧠'.repeat(MAX_MESSAGE_CHARS + 1);
  const capped = capMessage(emoji);
  assert.equal(messageLength(capped), MAX_MESSAGE_CHARS);
  assert.equal(capped.endsWith('🧠'), true);
  assert.equal(acceptSend(false, 'x'.repeat(MAX_MESSAGE_CHARS + 1)), false);
});

test('the server rejects an over-length message instead of sending it', async () => {
  const handler = (await import('../api/chat.js')).default;
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader() {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
    },
  };
  await handler(
    {
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.44' },
      url: '/api/chat',
      body: { message: 'x'.repeat(MAX_MESSAGE_CHARS + 1) },
    },
    res,
  );
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'message_too_long');
  assert.equal(res.body.message, 'That message is too long.');
});

test('an idempotency key with an unexpected character is rejected', async () => {
  const handler = (await import('../api/chat.js')).default;
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader() {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
    },
  };
  await handler(
    {
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.46', 'idempotency-key': 'bad\nkey' },
      url: '/api/chat',
      body: { message: 'hello there' },
    },
    res,
  );
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'bad_request');
  assert.equal(res.body.message, 'That request is not valid.');
  assert.equal(JSON.stringify(res.body).includes('\n'), false);
});

test('an oversized chat body is rejected before the model is called', async () => {
  const handler = (await import('../api/chat.js')).default;
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader() {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
    },
  };
  await handler(
    {
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.45' },
      url: '/api/chat',
      body: { message: 'x'.repeat(MAX_CHAT_BODY_BYTES) },
    },
    res,
  );
  assert.equal(res.statusCode, 413);
  assert.equal(res.body.error, 'payload_too_large');
  assert.equal(res.body.message, 'That request is too large.');
});

test('changing clips drops a reply that never produced text', () => {
  const kept = dropUnfinishedReply([
    { role: 'user', text: 'hello' },
    { role: 'assistant', text: 'partial' },
  ]);
  assert.equal(kept.length, 2);
  const dropped = dropUnfinishedReply([
    { role: 'user', text: 'hello' },
    { role: 'assistant', text: '' },
  ]);
  assert.deepEqual(dropped, [{ role: 'user', text: 'hello' }]);
});

test('retry sends the last user turn and drops the failed reply', () => {
  const turn = retryTurn([
    { role: 'user', text: 'first' },
    { role: 'assistant', text: 'ok' },
    { role: 'user', text: 'again' },
    { role: 'assistant', text: 'Chat is paused in this demo.', error: true },
  ]);
  assert.equal(turn.text, 'again');
  assert.equal(turn.prior.length, 2);
  assert.equal(retryTurn([{ role: 'assistant', text: 'done' }]), null);
  assert.equal(retryTurn([]), null);
});

test('why is rejected with an empty history and accepted once the thread has one', async () => {
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
  const handler = (await import('../api/chat.js')).default;
  const capture = () => {
    let raw = '';
    return {
      statusCode: 200,
      headers: {},
      setHeader() {},
      writeHead() {},
      write(chunk) { raw += chunk; this.raw = raw; },
      end() { this.raw = raw; },
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; },
    };
  };
  try {
    const empty = capture();
    await handler({
      method: 'POST',
      url: '/api/chat',
      headers: { 'x-vercel-ip-country': 'US', 'x-forwarded-for': '203.0.113.70' },
      body: { message: 'why', focus: { ids: ['v002'], timeSec: 0, view: 'explore' } },
    }, empty);
    assert.equal(empty.statusCode, 400);
    assert.equal(empty.body.error, 'message_too_short');
    assert.equal(mockChat.mockStarts, 0);

    const followed = capture();
    await handler({
      method: 'POST',
      url: '/api/chat',
      headers: { 'x-vercel-ip-country': 'US', 'x-forwarded-for': '203.0.113.70' },
      body: {
        message: 'why',
        history: [{ role: 'user', text: 'how many plays does this have?' }],
        focus: { ids: ['v002'], timeSec: 0, view: 'explore' },
      },
    }, followed);
    assert.notEqual(followed.body?.error, 'message_too_short');
    assert.equal(mockChat.mockStarts, 1);
    assert.match(followed.raw || '', /This is a mock answer/);
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
