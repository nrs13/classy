import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APP_FALLBACK, BRAIN_FALLBACK, boundaryLog } from '../src/lib/boundary.js';

test('an error boundary log keeps the name and drops the message', () => {
  const error = new Error('password=secret at /Users/private/file.js');
  error.name = 'TypeError';
  const line = boundaryLog('app', error);
  assert.equal(line, '[classy] app failed: TypeError');
  assert.equal(line.includes('secret'), false);
  assert.equal(line.includes('/Users'), false);
  assert.equal(boundaryLog('brain view!', null), '[classy] brainview failed: Error');
  assert.match(APP_FALLBACK, /Reload the page/);
  assert.match(BRAIN_FALLBACK, /brain view is unavailable/);
});
