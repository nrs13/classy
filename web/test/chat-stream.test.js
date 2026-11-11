import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mock, test } from 'node:test';
import { abortUpstreamOnDisconnect } from '../api/chat.js';
import { createIdempotencyStore } from '../server/chat/idempotency.js';
import { CUT_LABEL, OFFLINE_LABEL, readSseEvents, readWithIdle } from '../src/lib/streamFrame.js';

test('framing keeps a complete answer and names a cut', async () => {
  const chunks = [
    'data: {"type":"open"}\n\n',
    'data: {"type":"text","text":"Hello"}\n\n',
    'data: {"type":"done"}\n\n',
  ];
  let i = 0;
  const text = [];
  for await (const event of readSseEvents(async () => {
    if (i >= chunks.length) return { done: true, value: '' };
    return { done: false, value: chunks[i++] };
  })) {
    if (event.type === 'text') text.push(event.text);
  }
  assert.deepEqual(text, ['Hello']);

  let n = 0;
  const kept = [];
  await assert.rejects(
    (async () => {
      for await (const event of readSseEvents(async () => {
        n += 1;
        if (n === 1) return { done: false, value: 'data: {"type":"text","text":"Part"}\n\n' };
        return { done: true, value: '' };
      })) {
        kept.push(event.text);
      }
    })(),
    (err) => err.code === 'CUT',
  );
  assert.deepEqual(kept, ['Part']);
  assert.equal(CUT_LABEL, 'Connection lost. This answer may be incomplete.');
  assert.equal(OFFLINE_LABEL, "You're offline. Chat will work again when you reconnect.");
});

test('an idle gap over 20 seconds is a cut', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const pending = readWithIdle(() => new Promise(() => {}), 20_000);
  mock.timers.tick(20_000);
  await assert.rejects(pending, (err) => err.code === 'IDLE');
  mock.timers.reset();
});

test('a disconnect aborts the upstream request', () => {
  const req = new EventEmitter();
  const res = { writableEnded: false };
  const abort = new AbortController();
  abortUpstreamOnDisconnect(req, res, abort);
  req.emit('aborted');
  assert.equal(abort.signal.aborted, true);
});

test('the same send key is answered once', () => {
  let t = 1_000;
  const store = createIdempotencyStore(() => t);
  assert.equal(store.claim('send-1').fresh, true);
  assert.equal(store.claim('send-1').pending, true);
  store.finish('send-1', { kind: 'sse', text: 'Once' });
  assert.equal(store.claim('send-1').replay.text, 'Once');
  t += 61_000;
  assert.equal(store.claim('send-1').fresh, true);
});
