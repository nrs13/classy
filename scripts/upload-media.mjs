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
import https from 'node:https';
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

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) {
    console.error(`Set ${name} in the environment.`);
    process.exit(1);
  }
  if (/\s/.test(value) || /[/?#&%]/.test(value)) {
    console.error(`${name} contains a space or a character that cannot be part of that value. Type it again on its own line.`);
    process.exit(1);
  }
  return value;
}

const bucket = required('CLASSY_BUCKET');
const accountId = required('CLASSY_R2_ACCOUNT_ID');
const accessKeyId = required('CLASSY_R2_WRITE_ACCESS_KEY_ID');
const secretAccessKey = required('CLASSY_R2_WRITE_SECRET_ACCESS_KEY');

if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(bucket)) {
  console.error('CLASSY_BUCKET must be the lowercase bucket name, classy-media.');
  process.exit(1);
}
if (!/^[0-9a-f]{32}$/i.test(accountId)) {
  console.error('CLASSY_R2_ACCOUNT_ID must be the 32-character account id. Do not paste the S3 API address.');
  process.exit(1);
}
function shape(value) {
  const hex = /^[0-9a-f]+$/i.test(value);
  return `${value.length} characters, ${hex ? 'hex' : 'not hex'}`;
}

if (!/^[0-9a-f]{32}$/i.test(accessKeyId) || !/^[0-9a-f]{64}$/i.test(secretAccessKey)) {
  console.error(`Access key id is ${shape(accessKeyId)}. It must be 32 hex characters.`);
  console.error(`Secret is ${shape(secretAccessKey)}. It must be 64 hex characters.`);
  console.error('On the classy-write token page, Access Key ID is the shorter value and Secret Access Key is the longer one.');
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

function rawRequest(url, method, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request(
      {
        hostname: parsed.hostname,
        path: `${parsed.pathname}${parsed.search}`,
        method,
        timeout: timeoutMs,
        headers: body ? { 'content-length': body.length } : undefined,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

function r2Code(body) {
  return (String(body || '').match(/<Code>([^<]*)<\/Code>/) || [])[1] || '';
}

async function attempt(fn, times) {
  let last;
  for (let i = 0; i < times; i += 1) {
    try {
      return await fn();
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

async function remoteSize(objectKey) {
  const res = await attempt(() => rawRequest(sign('HEAD', objectKey), 'HEAD', undefined, 30000), 3);
  if (res.status === 404) return null;
  if (res.status !== 200) {
    let code = r2Code(res.body);
    if (!code) {
      const got = await rawRequest(sign('GET', objectKey), 'GET', undefined, 30000);
      code = r2Code(got.body);
    }
    throw new Error(`${objectKey} head ${res.status}${code ? ` ${code}` : ''}`);
  }
  const etag = String(res.headers.etag || '').replaceAll('"', '');
  return { size: Number(res.headers['content-length']), etag };
}

let same = 0;
let differ = 0;
let missing = 0;
let sent = 0;
let icloud = 0;

function onDisk(info) {
  return info.size === 0 || info.blocks > 0;
}

const paths = await filesUnder(root);
console.log(`checking ${paths.length} files`);
let checked = 0;
function note() {
  checked += 1;
  if (checked % 100 === 0) console.log(`checked ${checked}`);
}
for (const path of paths) {
  const objectKey = relative(root, path).split('\\').join('/');
  const info = await stat(path);
  if (!onDisk(info)) {
    icloud += 1;
    note();
    continue;
  }
  let remote;
  try {
    remote = await remoteSize(objectKey);
  } catch (err) {
    const message = err.message || 'head failed';
    if (/ head (400|403)/.test(message)) {
      console.error(message);
      console.error('Stopped on the first rejected check. No file was uploaded.');
      process.exit(1);
    }
    console.error(`${objectKey} head failed`);
    process.exitCode = 1;
    note();
    continue;
  }
  let match = remote && remote.size === info.size;
  if (match && remote.etag && !remote.etag.includes('-')) {
    try {
      const md5 = createHash('md5').update(await readFile(path)).digest('hex');
      match = md5 === remote.etag;
    } catch {
      match = true;
    }
  }
  if (match) {
    same += 1;
    note();
    continue;
  }
  if (!remote) missing += 1;
  else differ += 1;
  if (!upload) {
    note();
    continue;
  }
  let body;
  try {
    body = await attempt(() => readFile(path), 3);
  } catch {
    if (!remote) missing -= 1;
    else differ -= 1;
    icloud += 1;
    note();
    continue;
  }
  const putTimeout = Math.max(120000, Math.ceil(body.length / 50000) * 1000);
  let res;
  try {
    res = await attempt(() => rawRequest(sign('PUT', objectKey), 'PUT', body, putTimeout), 3);
  } catch {
    console.error(`${objectKey} put timed out`);
    process.exitCode = 1;
    note();
    continue;
  }
  if (res.status !== 200) {
    const code = r2Code(res.body);
    console.error(`${objectKey} put ${res.status}${code ? ` ${code}` : ''}`);
    process.exitCode = 1;
    note();
    continue;
  }
  sent += 1;
  note();
}

console.log(
  `${upload ? 'upload' : 'dry-run'} files=${paths.length} same=${same} missing=${missing} differ=${differ} sent=${sent} icloud=${icloud}`,
);
