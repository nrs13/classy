import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { APP_FALLBACK, BRAIN_FALLBACK } from '../src/lib/boundary.js';
import { lastRequestId, rememberRequestId } from '../src/lib/requestId.js';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const missingHtml = readFileSync(new URL('../public/404.html', import.meta.url), 'utf8');

test('the 404 page is a real page with no inline code', () => {
  assert.match(missingHtml, /This page is not here\./);
  assert.match(missingHtml, /href="\/"/);
  assert.match(missingHtml, /noindex, nofollow/);
  assert.equal(/<script/i.test(missingHtml), false);
  assert.equal(/style=/i.test(missingHtml), false);
  assert.match(missingHtml, /href="\/404\.css"/);
});

test('unknown static paths answer 404 and real files stay 200', async () => {
  const server = createServer((req, res) => {
    const path = decodeURIComponent((req.url || '/').split('?')[0]);
    const file = normalize(join(publicDir, path));
    if (path !== '/' && file.startsWith(publicDir) && existsSync(file) && statSync(file).isFile()) {
      res.writeHead(200, { 'Content-Type': extname(file) === '.css' ? 'text/css' : 'application/octet-stream' });
      res.end(readFileSync(file));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(missingHtml);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const missing = await fetch(`http://127.0.0.1:${port}/nothing`);
    assert.equal(missing.status, 404);
    assert.match(await missing.text(), /This page is not here\./);
    const sheet = await fetch(`http://127.0.0.1:${port}/404.css`);
    assert.equal(sheet.status, 200);
    const font = await fetch(`http://127.0.0.1:${port}/fonts/doto-700.woff2`);
    assert.equal(font.status, 200);
  } finally {
    server.close();
  }
});

test('the shell names JavaScript and shows a loading line', () => {
  assert.match(indexHtml, /Classy needs JavaScript to run\. This is a reduced demo of an internal project\./);
  assert.match(indexHtml, /href="https:\/\/nrsharan\.com"/);
  assert.match(indexHtml, /<div id="root">Loading\.<\/div>/);
  assert.match(indexHtml, /<title>Classy \(Demo\) - NRS<\/title>/);
  assert.match(indexHtml, /href="\/favicon-32\.png"/);
  assert.equal(indexHtml.includes('icon-192.png'), false);
  assert.match(indexHtml, /rel="canonical" href="https:\/\/classy\.nrsharan\.com\/"/);
  assert.equal(/<head>[\s\S]*Knowunity[\s\S]*<\/head>/.test(indexHtml), false);
  assert.equal(/<noscript>[^]*style=/i.test(indexHtml), false);
});

test('the crash copy and the brain fallback stay calm', () => {
  assert.equal(APP_FALLBACK, 'Something went wrong. Reload the page.');
  assert.equal(BRAIN_FALLBACK, 'The brain view is unavailable on this device.');
  const boundary = readFileSync(new URL('../src/components/ErrorBoundary.jsx', import.meta.url), 'utf8');
  assert.match(boundary, /Reload/);
  assert.match(boundary, /lastRequestId/);
  rememberRequestId('not safe');
  assert.equal(lastRequestId(), '');
  rememberRequestId('abc12345');
  assert.equal(lastRequestId(), 'abc12345');
});
