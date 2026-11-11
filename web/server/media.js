import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const MEDIA_TTL_MS = 10 * 60 * 1000;
const R2_EXPIRES_SEC = MEDIA_TTL_MS / 1000;

function secret() {
  return process.env.CLASSY_MEDIA_SECRET || 'classy-local-media';
}

export function signMedia(videoId, kind, objectKey, now = Date.now()) {
  const exp = now + MEDIA_TTL_MS;
  const body = Buffer.from(JSON.stringify({ videoId, kind, objectKey, exp })).toString('base64url');
  const sig = createHmac('sha256', secret()).update(body).digest('base64url');
  return { token: `${body}.${sig}`, exp };
}

export function verifyMedia(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', secret()).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload?.exp || payload.exp < Date.now()) return null;
  return payload;
}

function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalUri(bucket, objectKey) {
  const parts = [bucket, ...String(objectKey).split('/')].filter((part) => part.length > 0);
  return `/${parts.map(encodeRfc3986).join('/')}`;
}

function hmac(key, value) {
  return createHmac('sha256', key).update(value).digest();
}

function amzTimestamp(now) {
  const iso = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

/**
 * SigV4 presigned URL for Cloudflare R2 (S3 API, region auto).
 * Returns null when the bucket or the read credentials are unset, so dev keeps using local files.
 */
export function presignR2({
  method = 'GET',
  bucket,
  accountId,
  accessKeyId,
  secretAccessKey,
  objectKey,
  expiresSec = R2_EXPIRES_SEC,
  now = Date.now(),
  payloadHash = 'UNSIGNED-PAYLOAD',
} = {}) {
  if (!bucket || !accountId || !accessKeyId || !secretAccessKey || !objectKey) return null;
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const { amzDate, dateStamp } = amzTimestamp(now);
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const params = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Content-Sha256', payloadHash],
    ['X-Amz-Credential', `${accessKeyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(expiresSec)],
    ['X-Amz-SignedHeaders', 'host'],
  ];
  params.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const canonicalQuery = params.map(([key, value]) => `${encodeRfc3986(key)}=${encodeRfc3986(value)}`).join('&');
  const uri = canonicalUri(bucket, objectKey);
  const canonicalRequest = [
    method.toUpperCase(),
    uri,
    canonicalQuery,
    `host:${host}\n`,
    'host',
    payloadHash,
  ].join('\n');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), 'auto'), 's3'), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  return `https://${host}${uri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/** Short-lived read link. Empty bucket means the caller should serve the file from disk. */
export function signedMediaUrl(objectKey, now = Date.now()) {
  const bucket = process.env.CLASSY_BUCKET;
  if (!bucket) return null;
  return presignR2({
    method: 'GET',
    bucket,
    accountId: process.env.CLASSY_R2_ACCOUNT_ID,
    accessKeyId: process.env.CLASSY_R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.CLASSY_R2_SECRET_ACCESS_KEY,
    objectKey,
    expiresSec: R2_EXPIRES_SEC,
    now,
  });
}
