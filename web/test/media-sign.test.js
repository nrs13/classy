import assert from 'node:assert/strict';
import test from 'node:test';
import { MEDIA_TTL_MS, presignR2, signedMediaUrl, verifyMedia, signMedia } from '../server/media.js';

const NOW = Date.parse('2026-11-11T07:30:00.000Z');

test('an R2 read link is a 10 minute presigned GET and hides the secret', () => {
  const secret = 'example-secret';
  const url = presignR2({
    bucket: 'classy-media',
    accountId: 'example-account',
    accessKeyId: 'example-access',
    secretAccessKey: secret,
    objectKey: 'snapshots/ku/v001.mp4',
    now: NOW,
  });
  const parsed = new URL(url);
  assert.equal(parsed.protocol, 'https:');
  assert.equal(parsed.host, 'example-account.r2.cloudflarestorage.com');
  assert.equal(parsed.pathname, '/classy-media/snapshots/ku/v001.mp4');
  assert.equal(parsed.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
  assert.equal(parsed.searchParams.get('X-Amz-Expires'), '600');
  assert.equal(parsed.searchParams.get('X-Amz-Date'), '20261111T073000Z');
  assert.match(parsed.searchParams.get('X-Amz-Signature') || '', /^[0-9a-f]{64}$/);
  assert.equal(url.includes(secret), false);
  const again = presignR2({
    bucket: 'classy-media',
    accountId: 'example-account',
    accessKeyId: 'example-access',
    secretAccessKey: secret,
    objectKey: 'snapshots/ku/v001.mp4',
    now: NOW,
  });
  assert.equal(again, url);
});

test('no bucket means the caller keeps serving the file from disk', () => {
  const previous = process.env.CLASSY_BUCKET;
  delete process.env.CLASSY_BUCKET;
  assert.equal(signedMediaUrl('snapshots/ku/v001.mp4', NOW), null);
  if (previous === undefined) delete process.env.CLASSY_BUCKET;
  else process.env.CLASSY_BUCKET = previous;
});

test('a local media token older than 10 minutes is rejected', () => {
  const fresh = signMedia('v001', 'mp4', 'snapshots/ku/v001.mp4');
  const expired = signMedia('v001', 'mp4', 'snapshots/ku/v001.mp4', Date.now() - MEDIA_TTL_MS - 1000);
  assert.equal(verifyMedia(expired.token), null);
  assert.equal(verifyMedia(fresh.token)?.objectKey, 'snapshots/ku/v001.mp4');
});
