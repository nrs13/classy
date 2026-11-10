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
