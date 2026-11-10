import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadActivation } from '../src/lib/data.js';

test('loadActivation passes the abort signal and returns nothing when cancelled', async () => {
  const original = globalThis.fetch;
  let sawSignal = false;
  globalThis.fetch = (_url, opts) => {
    sawSignal = opts?.signal instanceof AbortSignal;
    return new Promise((_, reject) => {
      const fail = () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      };
      if (opts?.signal?.aborted) fail();
      else opts?.signal?.addEventListener('abort', fail, { once: true });
    });
  };
  const ctrl = new AbortController();
  const pending = loadActivation(
    { id: 'v001' },
    { synthetic: false, vertexCount: 3 },
    { signal: ctrl.signal },
  );
  ctrl.abort();
  assert.equal(await pending, null);
  assert.equal(sawSignal, true);
  globalThis.fetch = original;
});

test('loadActivation does not fetch when the signal is already aborted', async () => {
  const original = globalThis.fetch;
  let called = 0;
  globalThis.fetch = async () => {
    called += 1;
    return new Response('');
  };
  const ctrl = new AbortController();
  ctrl.abort();
  assert.equal(
    await loadActivation({ id: 'v001' }, { synthetic: false, vertexCount: 3 }, { signal: ctrl.signal }),
    null,
  );
  assert.equal(called, 0);
  globalThis.fetch = original;
});
