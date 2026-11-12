import assert from 'node:assert/strict';
import { test } from 'node:test';
import { numbersKept } from '../server/chat/numbers.js';

const fact = 'The pack is 97 videos. v002 has 31,300,000 plays and amplification 5,443×. Peak 0.0710 at second 6.';

test('every stored number must appear, and commas do not count as a change', () => {
  assert.equal(numbersKept(fact, '97 videos, 31300000 plays, 5443 times, peak 0.0710 at second 6.'), true);
  assert.equal(numbersKept(fact, '97 videos, 31,300,000 plays, 5,443 times, peak 0.0710 at second 6.'), true);
  assert.equal(numbersKept(fact, '97 videos, 31,300,000 plays, 5,443 times, peak 0.071 at second 6.'), false);
  assert.equal(numbersKept(fact, 'This is a mock answer.'), false);
});
