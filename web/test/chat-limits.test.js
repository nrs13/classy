import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptSend } from '../src/lib/chatLimits.js';

test('a second send is refused while one reply is in flight', () => {
  assert.equal(acceptSend(false, 'hello'), true);
  assert.equal(acceptSend(true, 'hello'), false);
  assert.equal(acceptSend(false, '   '), false);
  assert.equal(acceptSend(false, ''), false);
});
