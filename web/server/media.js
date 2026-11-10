import { createHmac, timingSafeEqual } from 'node:crypto';

export const MEDIA_TTL_MS = 10 * 60 * 1000;

function secret() {
  return process.env.CLASSY_MEDIA_SECRET || 'classy-local-media';
}

export function signMedia(videoId, kind, objectKey) {
  const exp = Date.now() + MEDIA_TTL_MS;
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

export async function signedGcsUrl(objectKey) {
  const bucket = process.env.CLASSY_BUCKET;
  if (!bucket) return null;
  const { Storage } = await import('@google-cloud/storage');
  const file = new Storage().bucket(bucket).file(objectKey);
  const [url] = await file.getSignedUrl({
    version: 'v4',
    action: 'read',
    expires: Date.now() + MEDIA_TTL_MS,
  });
  return url;
}
