import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { computedAnswer, questionsFor } from '../server/chat/computed.js';

const canned = JSON.parse(readFileSync(new URL('../server/chat/canned.json', import.meta.url), 'utf8'));

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

test('the generator reproduces the stored v002 answers', () => {
  const { clip, pack } = v002();
  for (const row of canned) {
    assert.equal(computedAnswer(row.question, clip, pack), row.answer, row.question);
  }
});

test('a missing number omits that question', () => {
  const { pack } = v002();
  const clip = { id: 'v003', duration: 7, plays: 100, followers: 10, amplification: 10 };
  assert.equal(computedAnswer("What's v003's peak mean cortical activation, and when does it occur?", clip, pack), null);
  assert.equal(questionsFor(clip, pack).some((q) => q.includes('peak')), false);
  assert.ok(questionsFor(clip, pack).some((q) => q.includes('amplification')));
});
