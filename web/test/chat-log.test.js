import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resetMockStarts } from '../server/chat/mock.js';

const QUESTION = 'user-text-not-for-logs-9f3a';

function sseCapture() {
  let raw = '';
  return {
    headers: {},
    statusCode: 200,
    body: undefined,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    writeHead() {},
    write(chunk) {
      raw += chunk;
    },
    end() {
      this.raw = raw;
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

test('a mock chat log records timings and tokens and leaves out the question', async () => {
  const prev = {
    mode: process.env.CHAT_MODE,
    provider: process.env.CHAT_PROVIDER,
    node: process.env.NODE_ENV,
    vercel: process.env.VERCEL_ENV,
    log: process.env.CLASSY_LOG,
  };
  process.env.CHAT_MODE = 'live';
  process.env.CHAT_PROVIDER = 'mock';
  process.env.NODE_ENV = 'test';
  process.env.CLASSY_LOG = 'json';
  delete process.env.VERCEL_ENV;
  resetMockStarts();
  const lines = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (...args) => {
    lines.push(String(args[0]));
    return write(...args);
  };
  try {
    const handler = (await import('../api/chat.js')).default;
    const res = sseCapture();
    await handler({
      method: 'POST',
      url: '/api/chat',
      headers: { 'x-vercel-ip-country': 'US', 'x-forwarded-for': '203.0.113.77' },
      body: {
        message: QUESTION,
        focus: { ids: ['v002'], timeSec: 0, view: 'explore' },
      },
    }, res);
    assert.match(res.raw || '', /This is a mock answer/);
    const blob = lines.join('');
    const start = blob.indexOf('{"at":');
    assert.ok(start >= 0);
    const end = blob.indexOf('\n', start);
    const row = JSON.parse(blob.slice(start, end === -1 ? undefined : end));
    assert.equal(row.route, 'chat');
    assert.equal(row.finishReason, 'STOP');
    const allowed = [
      'at', 'level', 'requestId', 'route', 'provider', 'model', 'finishReason',
      'inputTokens', 'thinkingTokens', 'outputTokens', 'firstTokenMs', 'totalMs', 'mode', 'reels',
    ];
    assert.deepEqual(Object.keys(row).sort(), [...allowed].sort());
    assert.equal(row.provider, 'mock');
    assert.equal(row.model, 'mock');
    assert.equal(row.inputTokens, 11);
    assert.equal(row.thinkingTokens, 0);
    assert.equal(row.outputTokens, 5);
    assert.equal(row.mode, 'explore');
    assert.equal(row.reels, 1);
    assert.equal(typeof row.firstTokenMs, 'number');
    assert.equal(typeof row.totalMs, 'number');
    assert.ok(row.totalMs >= row.firstTokenMs);
    const packed = JSON.stringify(row);
    assert.equal(packed.includes(QUESTION), false);
    assert.equal(packed.includes('This is a mock answer'), false);
    assert.equal(lines.join('').includes(QUESTION), false);
  } finally {
    process.stdout.write = write;
    if (prev.mode === undefined) delete process.env.CHAT_MODE;
    else process.env.CHAT_MODE = prev.mode;
    if (prev.provider === undefined) delete process.env.CHAT_PROVIDER;
    else process.env.CHAT_PROVIDER = prev.provider;
    if (prev.node === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prev.node;
    if (prev.vercel === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = prev.vercel;
    if (prev.log === undefined) delete process.env.CLASSY_LOG;
    else process.env.CLASSY_LOG = prev.log;
  }
});
