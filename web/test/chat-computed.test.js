import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { agreedAppAnswer, clipControlsAnswer, computedAnswer, questionsFor, unfinishedQuestion } from '../server/chat/computed.js';

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

test('the next agreed app is the later screen, and it is not named', () => {
  const clip = { agreed_app_screens: [{ t_sec: 4, evidence: 'Agreed app screen' }, { t_sec: 6, evidence: 'Agreed app screen' }] };
  assert.match(agreedAppAnswer('what is the next agreed app', clip, 1), /second 4/);
  assert.match(agreedAppAnswer('what is the next agreed app', clip, 1), /does not name the app/);
  assert.match(agreedAppAnswer('what is the next agreed app', clip, 5), /second 6/);
  assert.match(agreedAppAnswer('what is the next agreed app', clip, 6), /no later agreed app screen/);
  assert.match(agreedAppAnswer('what is the next agreed app', { agreed_app_screens: [] }, 0), /no agreed app screen/);
  assert.equal(agreedAppAnswer('what is on screen right now', clip, 1), null);
});

test('breakout and the next agreed app are answered together, including a typo', () => {
  const clip = {
    id: 'v002',
    metrics: { plays: 31_300_000, followers: 5750, amplification: 31_300_000 / 5750 },
    agreed_app_screens: [{ t_sec: 0 }, { t_sec: 4 }],
  };
  const text = clipControlsAnswer('what is the breakout and next agrred app', clip, 0);
  assert.match(text, /v002 is breakout/);
  assert.match(text, /31,300,000/);
  assert.match(text, /jumps to second 4/);
  assert.match(text, /does not name the app/);
  assert.match(unfinishedQuestion('what is the'), /Finish the question/);
  assert.equal(unfinishedQuestion('what is the breakout'), null);
});
