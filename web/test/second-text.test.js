import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fallbackSecondText, secondText } from '../src/lib/secondText.js';

const scenes = [
  {
    source: 'content_understanding',
    sentence: 'A young woman sits at a desk studying on a laptop and taking notes while on-screen Spanish text explains the lesson.',
  },
  { source: 'gemini', sentence: 'A student is studying at her desk while an on-screen text displays her thoughts.' },
];
const outcomes = [{ sentence: 'The narrator states they know which application to use.' }];

test('a missing packed sentence falls back to the longest stored line', () => {
  const text = fallbackSecondText(scenes, outcomes);
  assert.match(text, /young woman sits at a desk/);
  assert.equal(text.includes('narrator'), false);
  assert.equal(secondText({ scenes, outcomes, happens: '' }), text);
});

test('a packed sentence is shown and the originals are not required to change', () => {
  const packed = 'A young woman studies at her desk, taking notes on a laptop.';
  assert.equal(secondText({ scenes, outcomes, happens: packed }), packed);
});

test('no stored sentences stay an empty block', () => {
  assert.equal(fallbackSecondText([], []), '');
});
