import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptSend, retryTurn } from '../src/lib/chatLimits.js';

test('a second send is refused while one reply is in flight', () => {
  assert.equal(acceptSend(false, 'hello'), true);
  assert.equal(acceptSend(true, 'hello'), false);
  assert.equal(acceptSend(false, '   '), false);
  assert.equal(acceptSend(false, ''), false);
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
