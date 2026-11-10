import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptSend, capMessage, dropUnfinishedReply, MAX_MESSAGE_CHARS, messageLength, messageTooLong, retryTurn } from '../src/lib/chatLimits.js';

process.env.CLASSY_LOG = 'off';

test('a second send is refused while one reply is in flight', () => {
  assert.equal(acceptSend(false, 'hello'), true);
  assert.equal(acceptSend(true, 'hello'), false);
  assert.equal(acceptSend(false, '   '), false);
  assert.equal(acceptSend(false, ''), false);
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
