import { createReadStream, existsSync, statSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyMedia } from '../server/media.js';
import { errorBody } from '../server/obs/errors.js';
import { requestIdFrom } from '../server/obs/log.js';

function objectRoot() {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(process.env.CLASSY_OBJECT_ROOT || join(here, '..', '..', 'catalog', 'objects'));
}

const TYPES = { mp4: 'video/mp4', sprite: 'image/jpeg' };

function deny(res, status, error, requestId) {
  const body = JSON.stringify(errorBody(requestId, error));
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    'X-Request-Id': requestId,
  });
  res.end(body);
}

export default async function handler(req, res) {
  const requestId = requestIdFrom(req);
  if (req.method !== 'GET') {
    deny(res, 405, 'method_not_allowed', requestId);
    return;
  }
  const token = new URL(req.url || '', 'http://localhost').searchParams.get('token');
  const payload = verifyMedia(token);
  if (!payload?.objectKey) {
    deny(res, 403, 'forbidden', requestId);
    return;
  }
  const root = objectRoot();
  const path = normalize(join(root, payload.objectKey));
  if (!path.startsWith(root) || !existsSync(path)) {
    deny(res, 404, 'not_found', requestId);
    return;
  }
  const stat = statSync(path);
  const type = TYPES[payload.kind] || 'application/octet-stream';
  // Object keys include the snapshot id, so a sprite never changes under its key.
  const cache = payload.kind === 'sprite' ? 'private, max-age=31536000, immutable' : 'private, max-age=60';
  const range = req.headers?.range;
  if (range) {
    const match = /bytes=(\d+)-(\d*)/.exec(range);
    const start = match ? Number(match[1]) : 0;
    const end = match && match[2] ? Number(match[2]) : stat.size - 1;
    if (start >= stat.size || end < start) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      'Content-Type': type,
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Content-Length': end - start + 1,
      'Cache-Control': cache,
    });
    createReadStream(path, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Content-Length': stat.size,
    'Cache-Control': cache,
  });
  createReadStream(path).pipe(res);
}
