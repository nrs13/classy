import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catalogFailurePlan, loadActivation, loadCatalog, secondsFailed } from '../src/lib/data.js';

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

test('a failed seconds load is retryable unless the clip already changed', () => {
  assert.equal(secondsFailed(new AbortController().signal, { ok: false }), true);
  assert.equal(secondsFailed(AbortSignal.abort(), { ok: false }), false);
  assert.equal(secondsFailed(new AbortController().signal, { ok: true }), false);
});

test('a catalog failure still boots the brain, and an abort does not', () => {
  const fail = new Error('catalog');
  fail.code = 'catalog_unavailable';
  const plan = catalogFailurePlan(fail, false);
  assert.equal(plan.catalogError, true);
  assert.deepEqual(plan.manifest, { videos: [] });
  assert.equal(plan.loadBrain, true);
  const abort = new Error('aborted');
  abort.name = 'AbortError';
  assert.equal(catalogFailurePlan(abort, false), null);
  assert.equal(catalogFailurePlan(fail, true), null);
});

test('a failed catalog load is an error the page can retry', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500 });
  try {
    await assert.rejects(() => loadCatalog(), (err) => err.code === 'catalog_unavailable');
  } finally {
    globalThis.fetch = original;
  }
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
