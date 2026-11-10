import assert from 'node:assert/strict';
import { test } from 'node:test';
import { streamChatReply } from '../src/lib/ai.js';

function abortError() {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

test('streamChatReply does not start a request that is already aborted', async () => {
  const original = globalThis.fetch;
  let called = 0;
  globalThis.fetch = async () => {
    called += 1;
    return new Response('');
  };
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(
    streamChatReply({ message: 'hello', signal: ctrl.signal }).next(),
    (err) => err.name === 'AbortError' && err.code === 'ABORTED',
  );
  assert.equal(called, 0);
  globalThis.fetch = original;
});

test('streamChatReply stops when its signal aborts', async () => {
  const original = globalThis.fetch;
  let sawSignal = false;
  globalThis.fetch = (_url, opts) => {
    sawSignal = opts?.signal instanceof AbortSignal;
    return new Promise((_, reject) => {
      if (opts.signal?.aborted) reject(abortError());
      else opts.signal?.addEventListener('abort', () => reject(abortError()), { once: true });
    });
  };
  const ctrl = new AbortController();
  const pending = streamChatReply({ message: 'hello', signal: ctrl.signal }).next();
  ctrl.abort();
  await assert.rejects(pending, (err) => err.name === 'AbortError' && err.code === 'ABORTED');
  assert.equal(sawSignal, true);
  globalThis.fetch = original;
});
