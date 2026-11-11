import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

test('the video element only preloads metadata and the brain chunk is lazy', () => {
  const stage = readFileSync(new URL('../src/components/VideoStage.jsx', import.meta.url), 'utf8');
  const data = readFileSync(new URL('../src/lib/data.js', import.meta.url), 'utf8');
  assert.match(stage, /preload="metadata"/);
  assert.match(stage, /Connection is slow/);
  assert.match(stage, /lazy\(\(\) => import\('\.\/BrainViewer'\)\)/);
  assert.equal(data.includes("from 'three'"), false);
  assert.match(data, /import\('three'\)/);
});
