#!/usr/bin/env node
/**
 * Upload catalog/objects to the private R2 bucket.
 *
 * Uses the write token only (CLASSY_R2_WRITE_ACCESS_KEY_ID and
 * CLASSY_R2_WRITE_SECRET_ACCESS_KEY). The app's read token is not used.
 * Default is a dry run: compare size, and checksum when the remote ETag is a
 * single-part MD5. Pass --upload to send files that differ.
 *
 * Refuses to run when VERCEL is set or NODE_ENV=production.
 * Never prints credentials or signed URLs.
 *
 *   node scripts/upload-media.mjs
 *   node scripts/upload-media.mjs --upload
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { presignR2 } from '../web/server/media.js';

const here = dirname(fileURLToPath(import.meta.url));

if (process.env.VERCEL || process.env.NODE_ENV === 'production') {
  console.error('Refusing to upload from a production process.');
  process.exit(1);
}

const upload = process.argv.includes('--upload');
const root = join(here, '..', 'catalog', 'objects');
const bucket = process.env.CLASSY_BUCKET || '';
const accountId = process.env.CLASSY_R2_ACCOUNT_ID || '';
const accessKeyId = process.env.CLASSY_R2_WRITE_ACCESS_KEY_ID || '';
const secretAccessKey = process.env.CLASSY_R2_WRITE_SECRET_ACCESS_KEY || '';

if (!bucket || !accountId || !accessKeyId || !secretAccessKey) {
  console.error('Set CLASSY_BUCKET, CLASSY_R2_ACCOUNT_ID, and the write token in the environment.');
  process.exit(1);
}

async function filesUnder(dir) {
  const found = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await filesUnder(path)));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

function sign(method, objectKey) {
  const url = presignR2({
    method,
    bucket,
    accountId,
    accessKeyId,
    secretAccessKey,
    objectKey,
  });
  if (!url) throw new Error('could not sign');
  return url;
}

async function remoteSize(objectKey) {
  const res = await fetch(sign('HEAD', objectKey), { method: 'HEAD' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${objectKey} head ${res.status}`);
  const etag = (res.headers.get('etag') || '').replaceAll('"', '');
  return { size: Number(res.headers.get('content-length')), etag };
}

let same = 0;
let differ = 0;
let missing = 0;
let sent = 0;

const paths = await filesUnder(root);
for (const path of paths) {
  const objectKey = relative(root, path).split('\\').join('/');
  const info = await stat(path);
  const remote = await remoteSize(objectKey).catch((err) => {
    console.error(err.message || 'head failed');
    process.exitCode = 1;
    return undefined;
  });
  if (remote === undefined) continue;
  let match = remote && remote.size === info.size;
  if (match && remote.etag && !remote.etag.includes('-')) {
    const md5 = createHash('md5').update(await readFile(path)).digest('hex');
    match = md5 === remote.etag;
  }
  if (match) {
    same += 1;
    continue;
  }
  if (!remote) missing += 1;
  else differ += 1;
  if (!upload) continue;
  const body = await readFile(path);
  const res = await fetch(sign('PUT', objectKey), { method: 'PUT', body });
  if (!res.ok) {
    console.error(`${objectKey} put ${res.status}`);
    process.exitCode = 1;
    continue;
  }
  sent += 1;
}

console.log(
  `${upload ? 'upload' : 'dry-run'} files=${paths.length} same=${same} missing=${missing} differ=${differ} sent=${sent}`,
);
