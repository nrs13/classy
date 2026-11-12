import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatCacheKey, clearChatCache, readChatCache, writeChatCache } from '../server/chat/cache.js';
import { createChatGuard } from '../server/chat/guard.js';
import { messageTooShort } from '../src/lib/chatLimits.js';

test('visitor limits and the daily cap stop a live request', () => {
  let now = Date.parse('2026-11-10T18:00:00Z');
  const guard = createChatGuard({ now: () => now, dailyMax: 3, perMinute: 2, perHour: 3 });
  assert.equal(guard.take('203.0.113.8'), 1);
  assert.equal(guard.take('203.0.113.8'), 2);
  assert.throws(() => guard.take('203.0.113.8'), (err) => err.status === 429);
  now += 60_000;
  assert.equal(guard.take('203.0.113.8'), 3);
  assert.throws(() => guard.take('203.0.113.9'), (err) => err.status === 429);
  now += 86_400_000;
  assert.equal(guard.take('203.0.113.8'), 1);
});

test('chips use their own minute and do not spend the typed minute', () => {
  const guard = createChatGuard({ now: () => 1_000, dailyMax: 400, perMinute: 10, perHour: 60, chipPerMinute: 20 });
  for (let i = 0; i < 20; i += 1) guard.take('203.0.113.50', 'chip');
  assert.throws(() => guard.take('203.0.113.50', 'chip'), (err) => err.status === 429);
  assert.equal(guard.take('203.0.113.50', 'typed'), 21);
  assert.equal(guard.inspect('203.0.113.50').state, 'ok');
  for (let i = 0; i < 9; i += 1) guard.take('203.0.113.51', 'typed');
  assert.equal(guard.take('203.0.113.51', 'typed'), 31);
  assert.throws(() => guard.take('203.0.113.51', 'typed'), (err) => err.status === 429);
  assert.equal(guard.take('203.0.113.51', 'chip'), 32);
});

test('an identical question and clip is cached, and a short message is refused', () => {
  clearChatCache();
  const focus = { ids: ['v002'], timeSec: 3.8, modes: ['marketing'] };
  const key = chatCacheKey('  How did v002 grow? ', focus);
  assert.equal(readChatCache(key), null);
  writeChatCache(key, 'Stored reply.');
  assert.equal(readChatCache(key), 'Stored reply.');
  assert.equal(chatCacheKey('How did v002 grow?', { ids: ['v014'], timeSec: 3, modes: ['marketing'] }) === key, false);
  assert.equal(messageTooShort('short'), true);
  assert.equal(messageTooShort('long enough'), false);
});

test('the server rejects a too-short chat message before a model call', async () => {
  const handler = (await import('../api/chat.js')).default;
  const res = {
    statusCode: 200,
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
  await handler({ method: 'POST', headers: {}, url: '/api/chat', body: { message: 'short' } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'message_too_short');
});
