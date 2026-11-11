import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiFetch } from '../src/lib/apiFetch.js';

test('GET retries a 503 and stops on a 4xx', async () => {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async () => {
    seen.push('call');
    if (seen.length < 3) {
      return new Response('busy', { status: 503, headers: { 'retry-after': '0' } });
    }
    return new Response('ok', { status: 200 });
  };
  const res = await apiFetch('/api/catalog');
  assert.equal(res.status, 200);
  assert.equal(seen.length, 3);

  seen.length = 0;
  globalThis.fetch = async () => {
    seen.push('call');
    return new Response('no', { status: 404 });
  };
  const missing = await apiFetch('/api/catalog');
  assert.equal(missing.status, 404);
  assert.equal(seen.length, 1);
  globalThis.fetch = original;
});

test('a POST is not retried', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('no', { status: 503 });
  };
  const res = await apiFetch('/api/chat', { method: 'POST', body: '{}' });
  assert.equal(res.status, 503);
  assert.equal(calls, 1);
  globalThis.fetch = original;
});
