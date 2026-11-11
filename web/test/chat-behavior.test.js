import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyOnlineState } from '../src/lib/connection.js';
import { LIVE_REGION, onQuotaClock, quotaAnnouncement, secondsLeft } from '../src/lib/quota.js';
import { OFFLINE_LABEL } from '../src/lib/streamFrame.js';
import { mockStarts, resetMockStarts } from '../server/chat/mock.js';
import { effectiveChatMode } from '../server/chat/mode.js';

process.env.CLASSY_LOG = 'off';

function capture() {
  let raw = '';
  return {
    headers: {},
    statusCode: 200,
    body: undefined,
    writableEnded: false,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    writeHead() {},
    write(chunk) {
      raw += chunk;
      this.raw = raw;
    },
    end() {
      this.raw = raw;
      this.writableEnded = true;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
    },
  };
}

test('offline then online refetches only on the way back', () => {
  let online = true;
  let fetches = 0;
  for (const event of ['offline', 'online', 'online']) {
    const next = applyOnlineState(online, event);
    if (next.refetch) fetches += 1;
    online = next.online;
  }
  assert.equal(online, true);
  assert.equal(fetches, 1);
  assert.equal(OFFLINE_LABEL, "You're offline. Chat will work again when you reconnect.");
});

test('a visible tab rechecks only after the deadline', () => {
  const until = 10_000;
  assert.equal(onQuotaClock({ until, now: 9_000, visibility: 'hidden', reason: 'visible' }), false);
  assert.equal(onQuotaClock({ until, now: 9_000, visibility: 'visible', reason: 'visible' }), false);
  assert.equal(onQuotaClock({ until, now: 10_000, visibility: 'hidden', reason: 'visible' }), false);
  assert.equal(onQuotaClock({ until, now: 10_000, visibility: 'visible', reason: 'visible' }), true);
  assert.equal(onQuotaClock({ until, now: 10_000, visibility: 'hidden', reason: 'timer' }), true);
});

test('the quota live region announces the seconds left on the deadline', () => {
  const until = 50_000;
  const early = quotaAnnouncement({ scope: 'minute_quota', retryAfterSeconds: 23 }, secondsLeft(until, 27_000));
  const later = quotaAnnouncement({ scope: 'minute_quota', retryAfterSeconds: 23 }, secondsLeft(until, 49_400));
  assert.equal(early, 'You can send again in 23 s');
  assert.equal(later, 'You can send again in 1 s');
  assert.equal(LIVE_REGION.role, 'status');
  assert.equal(LIVE_REGION['aria-live'], 'polite');
  const daily = quotaAnnouncement(
    { scope: 'day_quota', resetAt: '2026-11-12T20:45:00.000Z' },
    0,
    Date.parse('2026-11-12T17:30:00.000Z'),
  );
  assert.match(daily, /today's free limit/);
});

test('a second post with the same key does not start the mock again', async () => {
  const prev = {
    mode: process.env.CHAT_MODE,
    provider: process.env.CHAT_PROVIDER,
    node: process.env.NODE_ENV,
    vercel: process.env.VERCEL_ENV,
  };
  process.env.CHAT_MODE = 'live';
  process.env.CHAT_PROVIDER = 'mock';
  process.env.NODE_ENV = 'test';
  delete process.env.VERCEL_ENV;
  resetMockStarts();
  const handler = (await import('../api/chat.js')).default;
  const headers = {
    'idempotency-key': 'double-post-step10',
    'x-vercel-ip-country': 'US',
    'x-classy-chat-fault': 'slow_stream',
  };
  const body = {
    message: 'How does a second identical send stay on the first reply?',
    focus: { ids: ['v002'] },
  };
  const first = capture();
  const started = Date.now();
  let firstByteMs = 0;
  const write = first.write.bind(first);
  first.write = (chunk) => {
    if (!firstByteMs) firstByteMs = Date.now() - started;
    write(chunk);
  };
  const pending = handler({ method: 'POST', headers, url: '/api/chat?chatFault=slow_stream&chatSlowMs=80', body }, first);
  const second = capture();
  await handler({ method: 'POST', headers, url: '/api/chat?chatSlowMs=80&chatFault=slow_stream', body }, second);
  await pending;
  assert.equal(mockStarts, 1);
  assert.equal(second.body?.scope, 'visitor_rate');
  assert.match(first.raw || '', /data: \{"type":"open"\}/);
  assert.ok(firstByteMs > 0 && firstByteMs < 5_000);
  if (prev.mode === undefined) delete process.env.CHAT_MODE;
  else process.env.CHAT_MODE = prev.mode;
  if (prev.provider === undefined) delete process.env.CHAT_PROVIDER;
  else process.env.CHAT_PROVIDER = prev.provider;
  if (prev.node === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = prev.node;
  if (prev.vercel === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = prev.vercel;
});

test('a mock quota fault is a JSON refusal before the stream opens', async () => {
  const prev = {
    mode: process.env.CHAT_MODE,
    provider: process.env.CHAT_PROVIDER,
    node: process.env.NODE_ENV,
    vercel: process.env.VERCEL_ENV,
  };
  process.env.CHAT_MODE = 'live';
  process.env.CHAT_PROVIDER = 'mock';
  process.env.NODE_ENV = 'test';
  delete process.env.VERCEL_ENV;
  const handler = (await import('../api/chat.js')).default;
  const res = capture();
  await handler({
    method: 'POST',
    headers: { 'x-vercel-ip-country': 'US', 'x-classy-chat-fault': 'minute_quota' },
    url: '/api/chat',
    body: { message: 'What does a minute quota look like here?', focus: { ids: ['v002'] } },
  }, res);
  assert.equal(res.statusCode, 429);
  assert.equal(res.body?.scope, 'minute_quota');
  assert.equal(res.body?.retryAfterSeconds, 60);
  assert.equal(res.raw || '', '');
  if (prev.mode === undefined) delete process.env.CHAT_MODE;
  else process.env.CHAT_MODE = prev.mode;
  if (prev.provider === undefined) delete process.env.CHAT_PROVIDER;
  else process.env.CHAT_PROVIDER = prev.provider;
  if (prev.node === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = prev.node;
  if (prev.vercel === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = prev.vercel;
});

test('local mock stays live when the country header is missing', () => {
  assert.equal(effectiveChatMode({ CHAT_MODE: 'live', CHAT_PROVIDER: 'mock', NODE_ENV: 'test' }, ''), 'live');
  assert.equal(effectiveChatMode({ CHAT_MODE: 'live', CHAT_PROVIDER: 'mock', NODE_ENV: 'test' }, 'FR'), 'canned');
  assert.equal(effectiveChatMode({ CHAT_MODE: 'live', CHAT_PROVIDER: 'mock', NODE_ENV: 'production' }, ''), 'canned');
});
