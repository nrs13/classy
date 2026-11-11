import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { applyLenses } from '../server/chat/lenses.js';
import { matchCanned } from '../server/chat/mode.js';
import { computedAnswer } from '../server/chat/computed.js';
import { normalizeReplyModes } from '../src/lib/replyModes.js';
import { mockStarts, resetMockStarts } from '../server/chat/mock.js';

const canned = JSON.parse(readFileSync(new URL('../server/chat/canned.json', import.meta.url), 'utf8'));
const stored = canned.find((row) => row.videoId === 'v002');

const SELECTIONS = [
  [[], []],
  [['marketing'], ['Marketing']],
  [['analytics'], ['Analytics']],
  [['research'], ['Research']],
  [['analytics', 'marketing'], ['Marketing', 'Analytics']],
  [['research', 'marketing'], ['Marketing', 'Research']],
  [['research', 'analytics'], ['Analytics', 'Research']],
  [['research', 'marketing', 'analytics', 'marketing', 'not a lens'], ['Marketing', 'Analytics', 'Research']],
];

function numbers(text) {
  return new Set(String(text).match(/\d+(?:\.\d+)?/g) || []);
}

function v002() {
  const slopes = Array.from({ length: 97 }, () => 0.0009);
  slopes[0] = -0.0207;
  slopes[96] = 0.0164;
  for (let i = 74; i < 96; i += 1) slopes[i] = 0.01;
  slopes[73] = 0.0061;
  return {
    clip: {
      id: 'v002',
      duration: 7,
      plays: 31_300_000,
      followers: 5750,
      amplification: 31_300_000 / 5750,
      hook_slope: 0.0061,
      sustain_ratio: 1,
      curve: [{ t_sec: 6, mean_abs: 0.071 }],
      networks: {
        top: ['Visual', 'Dorsal Attention', 'Somatomotor'],
        means: { Visual: 0.126, 'Dorsal Attention': 0.0697, Somatomotor: 0.0664 },
      },
    },
    pack: { n: 97, slopes },
  };
}

function labelsInOrder(text, labels) {
  let at = -1;
  for (const label of labels) {
    const next = text.indexOf(`${label}\n`, at + 1);
    assert.ok(next > at, label);
    at = next;
  }
  const known = ['Marketing', 'Analytics', 'Research'];
  for (const label of known) {
    if (!labels.includes(label)) assert.equal(text.includes(`${label}\n`), false, label);
  }
}

test('lens names are an allow-list and duplicates are dropped', () => {
  assert.deepEqual(normalizeReplyModes(['marketing', 'marketing', 'write anything']), ['marketing']);
  assert.deepEqual(normalizeReplyModes('marketing'), []);
});

test('all eight lens selections shape one stored answer in order', () => {
  const focus = { ids: ['v002'] };
  for (const [modes, labels] of SELECTIONS) {
    const base = matchCanned(stored.question, focus);
    assert.equal(base, stored.answer);
    const shaped = applyLenses(base, modes);
    if (!labels.length) {
      assert.equal(shaped, stored.answer);
      continue;
    }
    labelsInOrder(shaped, labels);
    for (const value of numbers(shaped)) assert.ok(numbers(stored.answer).has(value), value);
  }
});

test('a computed answer keeps only the stored clip numbers', () => {
  const { clip, pack } = v002();
  const question = "What's v002's peak mean cortical activation, and when does it occur?";
  const base = computedAnswer(question, clip, pack);
  assert.equal(base, canned.find((row) => row.question === question).answer);
  for (const [modes] of SELECTIONS) {
    const shaped = applyLenses(base, modes);
    if (!modes.length) assert.equal(shaped, base);
    for (const value of numbers(shaped)) assert.ok(numbers(base).has(value), value);
  }
});

function capture() {
  let raw = '';
  return {
    headers: {},
    statusCode: 200,
    body: undefined,
    writableEnded: false,
    setHeader() {},
    writeHead() {},
    write(chunk) {
      raw += chunk;
      this.raw = raw;
    },
    end() {
      this.raw = raw;
      this.writableEnded = true;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
    },
  };
}

test('each lens selection is one mock call, and the same key with the same lenses is not', async () => {
  const prev = {
    mode: process.env.CHAT_MODE,
    provider: process.env.CHAT_PROVIDER,
    node: process.env.NODE_ENV,
    vercel: process.env.VERCEL_ENV,
  };
  process.env.CHAT_MODE = 'live';
  process.env.CHAT_PROVIDER = 'mock';
  process.env.NODE_ENV = 'test';
  delete process.env.VERCEL_ENV;
  resetMockStarts();
  const handler = (await import('../api/chat.js')).default;
  const message = 'Describe this second without using a stored question.';
  let expected = 0;
  for (const [modes, index] of SELECTIONS.map((row, i) => [row[0], i])) {
    const before = mockStarts;
    const res = capture();
    await handler({
      method: 'POST',
      headers: {
        'idempotency-key': `lens-${modes.join('-') || 'none'}`,
        'x-vercel-ip-country': 'US',
        'x-forwarded-for': `10.11.0.${index}`,
      },
      url: '/api/chat',
      body: { message, focus: { ids: ['v002'], modes } },
    }, res);
    assert.equal(mockStarts, before + 1, modes.join(',') || 'none');
    assert.equal((res.raw.match(/This is a mock answer\./g) || []).length, 1);
    expected += 1;
  }
  assert.equal(mockStarts, expected);
  const repeat = capture();
  await handler({
    method: 'POST',
    headers: {
      'idempotency-key': 'lens-marketing',
      'x-vercel-ip-country': 'US',
      'x-forwarded-for': '10.11.0.1',
    },
    url: '/api/chat',
    body: { message, focus: { ids: ['v002'], modes: ['marketing'] } },
  }, repeat);
  assert.equal(mockStarts, expected);
  assert.match(repeat.raw || '', /This is a mock answer\./);
  const fresh = 'A second question that is not one of the stored prompts.';
  const firstLens = capture();
  await handler({
    method: 'POST',
    headers: {
      'idempotency-key': 'shared-lens-key',
      'x-vercel-ip-country': 'US',
      'x-forwarded-for': '10.11.1.1',
    },
    url: '/api/chat',
    body: { message: fresh, focus: { ids: ['v002'], modes: ['marketing'] } },
  }, firstLens);
  assert.equal(mockStarts, expected + 1);
  const other = capture();
  await handler({
    method: 'POST',
    headers: {
      'idempotency-key': 'shared-lens-key',
      'x-vercel-ip-country': 'US',
      'x-forwarded-for': '10.11.1.1',
    },
    url: '/api/chat',
    body: { message: fresh, focus: { ids: ['v002'], modes: ['analytics', 'research'] } },
  }, other);
  assert.equal(mockStarts, expected + 2);
  assert.equal((other.raw.match(/This is a mock answer\./g) || []).length, 1);
  if (prev.mode === undefined) delete process.env.CHAT_MODE;
  else process.env.CHAT_MODE = prev.mode;
  if (prev.provider === undefined) delete process.env.CHAT_PROVIDER;
  else process.env.CHAT_PROVIDER = prev.provider;
  if (prev.node === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = prev.node;
  if (prev.vercel === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = prev.vercel;
});
