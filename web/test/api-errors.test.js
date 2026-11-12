import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.CLASSY_LOG = 'off';

const { errorBody } = await import('../server/obs/errors.js');

function jsonRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    writeHead(code, headers) {
      this.statusCode = code;
      Object.assign(this.headers, headers);
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
    },
    end(payload) {
      this.body = payload;
    },
  };
}

test('every API error uses the same JSON shape', () => {
  const body = errorBody('req-1', 'unknown_route');
  assert.deepEqual(body, {
    requestId: 'req-1',
    error: 'unknown_route',
    message: 'That request was not found.',
  });
});

test('chat rejects an empty message with the shared error shape', async () => {
  const handler = (await import('../api/chat.js')).default;
  const res = jsonRes();
  await handler({ method: 'POST', headers: {}, url: '/api/chat', body: { message: '   ' } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'empty_message');
  assert.equal(res.body.message, 'That message is empty.');
  assert.equal(typeof res.body.requestId, 'string');
  assert.ok(res.body.requestId.length >= 8);
});

test('an unknown API path is JSON 404', async () => {
  const handler = (await import('../api/[...path].js')).default;
  const res = jsonRes();
  await handler({ method: 'GET', headers: {}, url: '/api/missing' }, res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, 'unknown_route');
  assert.equal(res.body.message, 'That request was not found.');
  assert.equal(typeof res.body.requestId, 'string');
  assert.equal(JSON.stringify(res.body).includes('stack'), false);
});

test('a byte range past the end is JSON, not an empty body', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { signMedia } = await import('../server/media.js');
  const dir = mkdtempSync(join(tmpdir(), 'classy-object-'));
  writeFileSync(join(dir, 'clip.mp4'), Buffer.from('0123456789'));
  const previous = process.env.CLASSY_OBJECT_ROOT;
  process.env.CLASSY_OBJECT_ROOT = dir;
  try {
    const { token } = signMedia('v001', 'mp4', 'clip.mp4');
    const handler = (await import('../api/object.js')).default;
    const res = jsonRes();
    await handler(
      { method: 'GET', headers: { range: 'bytes=50-60' }, url: `/api/object?token=${encodeURIComponent(token)}` },
      res,
    );
    assert.equal(res.statusCode, 416);
    const body = JSON.parse(res.body);
    assert.deepEqual(Object.keys(body).sort(), ['error', 'message', 'requestId']);
    assert.equal(body.error, 'bad_request');
    assert.equal(body.message, 'That request is not valid.');
    assert.equal(body.message.includes(dir), false);
  } finally {
    if (previous == null) delete process.env.CLASSY_OBJECT_ROOT;
    else process.env.CLASSY_OBJECT_ROOT = previous;
  }
});

test('an object request without a token is a JSON refusal', async () => {
  const handler = (await import('../api/object.js')).default;
  const res = jsonRes();
  await handler({ method: 'GET', headers: {}, url: '/api/object' }, res);
  assert.equal(res.statusCode, 403);
  const body = JSON.parse(res.body);
  assert.equal(body.error, 'forbidden');
  assert.equal(body.message, "This video can't play right now.");
  assert.equal(typeof body.requestId, 'string');
  assert.equal(res.headers['Cache-Control'], 'no-store');
});
