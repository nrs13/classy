import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHAT_PAUSED, formatChatError, streamChatReply } from '../src/lib/ai.js';

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

test('an unavailable model says the demo is paused', () => {
  for (const status of [401, 429, 500, 502, 503]) {
    const err = new Error(`chat backend error (${status})`);
    err.status = status;
    assert.equal(formatChatError(err), CHAT_PAUSED);
  }
  const quota = new Error('usage limit');
  quota.code = 'BOTH_MODELS_QUOTA';
  assert.equal(formatChatError(quota), CHAT_PAUSED);
  const spend = new Error('over budget');
  spend.code = 'SPEND_CAP';
  spend.status = 402;
  assert.equal(formatChatError(spend), CHAT_PAUSED);
  assert.equal(formatChatError(new Error('the assistant is unavailable right now')), CHAT_PAUSED);
  assert.equal(formatChatError(new Error('The model declined to answer that.')).includes('paused'), false);
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
