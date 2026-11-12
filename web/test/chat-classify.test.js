import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyGemini429, classifyProviderFailure, failureBody, parseRetryDelay } from '../server/chat/classify.js';

const DAY_BODY = JSON.stringify({
  error: {
    code: 429,
    status: 'RESOURCE_EXHAUSTED',
    message: 'quota message that must not leak',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel', quotaMetric: 'generate_content_free_tier_requests' }],
      },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '12.2s' },
    ],
  },
});

test('a Gemini 429 names the quota and the retry delay', () => {
  const day = classifyGemini429(DAY_BODY);
  assert.equal(day.scope, 'day_quota');
  assert.equal(day.retryAfterSeconds, null);
  assert.equal(JSON.stringify(day).includes('must not leak'), false);
  const minute = classifyGemini429(JSON.stringify({
    error: {
      details: [
        { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'RATE_LIMIT_EXCEEDED', metadata: { quota_metric: 'generate_requests_per_minute' } },
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: { seconds: '8', nanos: 1 } },
      ],
    },
  }));
  assert.equal(minute.scope, 'minute_quota');
  assert.equal(minute.retryAfterSeconds, 9);
  const unknown = classifyGemini429('not json');
  assert.equal(unknown.scope, 'minute_quota');
  assert.equal(unknown.retryAfterSeconds, 60);
});

test('provider failures stay inside the eight classes', () => {
  assert.equal(classifyProviderFailure(401, 'raw key text').scope, 'auth');
  assert.equal(classifyProviderFailure(403, '').scope, 'auth');
  assert.equal(classifyProviderFailure(500, 'boom').scope, 'server');
  assert.equal(classifyProviderFailure(0, '', 'timeout').scope, 'timeout');
  assert.equal(classifyProviderFailure(0, '', 'network').scope, 'network');
  assert.equal(parseRetryDelay('30s'), 30);
  const body = failureBody('abc', classifyProviderFailure(401, 'secret'));
  assert.deepEqual(Object.keys(body).sort(), ['error', 'message', 'requestId', 'resetAt', 'retryAfterSeconds', 'scope']);
  assert.equal(body.error, 'auth');
  assert.equal(body.message, 'Chat is paused in this demo.');
  assert.equal(JSON.stringify(body).includes('secret'), false);
});
