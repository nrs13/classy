import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { nextPacificMidnight } from '../server/chat/resetAt.js';
import { coolingDeadline, quotaMessage, secondsLeft, startCountdown } from '../src/lib/quota.js';

test('Pacific midnight moves with the November and March clock changes', () => {
  assert.equal(nextPacificMidnight('2026-11-01T07:30:00.000Z'), '2026-11-02T08:00:00.000Z');
  assert.equal(nextPacificMidnight('2026-11-01T06:30:00.000Z'), '2026-11-01T07:00:00.000Z');
  assert.equal(nextPacificMidnight('2027-03-08T20:00:00.000Z'), '2027-03-09T08:00:00.000Z');
  assert.equal(nextPacificMidnight('2027-03-13T20:00:00.000Z'), '2027-03-14T08:00:00.000Z');
  assert.equal(nextPacificMidnight('2027-03-14T09:30:00.000Z'), '2027-03-15T07:00:00.000Z');
  assert.equal(nextPacificMidnight('2027-03-14T10:30:00.000Z'), '2027-03-15T07:00:00.000Z');
  assert.equal(nextPacificMidnight('2027-03-15T18:00:00.000Z'), '2027-03-16T07:00:00.000Z');
});

test('a daily limit names the visitor local time', () => {
  const resetAt = new Date('2026-11-12T20:45:00.000Z').toISOString();
  const text = quotaMessage(
    { scope: 'day_quota', resetAt },
    Date.parse('2026-11-12T17:30:00.000Z'),
  );
  assert.match(text, /Chat has reached today's free limit\. It comes back at .+ in about 3 hours\./);
});

test('the countdown reads one deadline instead of counting down by one', () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const start = Date.now();
  const until = coolingDeadline(23, start);
  assert.equal(until, start + 23_000);
  const seen = [];
  const stop = startCountdown(until, (left) => seen.push(left));
  mock.timers.tick(2500);
  assert.equal(seen.at(-1), secondsLeft(until, start + 2500));
  assert.equal(seen.at(-1), 21);
  stop();
  mock.timers.reset();
});

test('the minute countdown reaches zero and stops', () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const seen = [];
  const stop = startCountdown(Date.now() + 3000, (left) => seen.push(left));
  assert.deepEqual(seen, [3]);
  mock.timers.tick(1000);
  mock.timers.tick(1000);
  mock.timers.tick(1000);
  assert.equal(seen.at(-1), 0);
  assert.equal(secondsLeft(Date.now() + 500, Date.now()), 1);
  stop();
  mock.timers.reset();
});
