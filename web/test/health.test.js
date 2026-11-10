import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.CLASSY_LOG = 'off';

const handler = (await import('../api/health.js')).default;

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    headersSent: false,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      this.headersSent = true;
    },
  };
}

test('GET /api/health says the process is up and is not cached', async () => {
  const res = fakeRes();
  await handler({ method: 'GET', headers: {}, url: '/api/health' }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(JSON.stringify(res.body).includes('stack'), false);
});

test('other methods on /api/health are a clean rejection', async () => {
  const res = fakeRes();
  await handler({ method: 'POST', headers: {}, url: '/api/health' }, res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.body.error, 'method_not_allowed');
  assert.equal(typeof res.body.message, 'string');
  assert.equal(JSON.stringify(res.body).includes('stack'), false);
});
