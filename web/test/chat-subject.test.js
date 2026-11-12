import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answerSubject, asksToCompare, canAsk } from '../src/lib/answerSubject.js';
import { windowTimeline } from '../server/chat/knowledge.js';
import { conversationBrief } from '../server/chat/promptBlocks.js';

test('the next answer names the open reel and refuses a one-reel comparison', () => {
  const reels = [
    { id: 'v001', account: 'Ada' },
    { id: 'v002', account: 'Bea' },
    { id: 'v003', account: 'Ada' },
  ];
  assert.equal(answerSubject('explore', reels, ['v002']).text, 'Bea');
  assert.equal(answerSubject('search', reels, ['v001']).text, 'Ada (v001)');
  assert.equal(answerSubject('explore', reels, []).ready, false);
  const one = answerSubject('compare', reels, ['v002']);
  assert.equal(one.ready, false);
  assert.equal(one.text, 'Another reel is needed before Classy can compare.');
  const set = answerSubject('compare', reels, ['v001', 'v002']);
  assert.equal(set.ready, true);
  assert.equal(set.text, 'Ada (v001), Bea');
  assert.equal(canAsk('compare', reels, ['v002'], 'what is a hook slope').ready, true);
  assert.equal(canAsk('compare', reels, ['v002'], 'compare these reels').ready, false);
  assert.equal(asksToCompare('what is Classy'), false);
});

test('the timeline sent to the model is the playhead window plus a named second', () => {
  const rows = Array.from({ length: 20 }, (_, t) => ({ t_sec: t, line: `s${t}` }));
  const kept = windowTimeline(rows, 10, new Set([18]));
  assert.deepEqual(kept.map((row) => row.t_sec), [8, 9, 10, 11, 12, 18]);
});

test('a comparison tells the model the clips are one set', () => {
  const brief = conversationBrief({
    videos: [
      { id: 'v001', metrics: {}, features: {} },
      { id: 'v002', metrics: {}, features: {} },
    ],
  }, { view: 'compare', timeSec: 0 });
  assert.match(brief, /These clips are compared together/);
  assert.match(brief, /Compared: v002/);
  assert.equal(brief.includes('Also open'), false);
});

test('a non-compare brief lists every reel and drops the short peer list', () => {
  const brief = conversationBrief({
    directory: [{ id: 'v114', account: 'studygram', language: 'en', topics: ['English'], plays: 12400000, tier: 'breakout' }],
    peers: [{ id: 'v114', account: 'studygram', plays: 12400000, tier: 'breakout', topics: ['English'] }],
    videos: [{ id: 'v002', metrics: { plays: 1, tier: 'tail' }, features: {} }],
  }, { timeSec: 0, view: 'explore' });
  assert.match(brief, /Directory: v114, studygram, en, English, 12,400,000 plays, breakout/);
  assert.equal(brief.includes('Other clips, most plays first'), false);
});

test('a compare brief does not add the directory', () => {
  const brief = conversationBrief({
    directory: [{ id: 'v114', account: 'studygram', language: 'en', topics: [], plays: 1, tier: 'tail' }],
    videos: [
      { id: 'v001', metrics: {}, features: {} },
      { id: 'v002', metrics: {}, features: {} },
    ],
  }, { view: 'compare', timeSec: 0 });
  assert.equal(brief.includes('Directory:'), false);
  assert.equal(brief.includes('Also open'), false);
});

test('a compared reel keeps its own seconds inside the fence', () => {
  const brief = conversationBrief({
    videos: [
      { id: 'v001', metrics: {}, features: {}, timeline: [{ t_sec: 0, line: 'First reel.' }] },
      { id: 'v002', metrics: {}, features: {}, timeline: [{ t_sec: 0, line: 'Second reel.' }] },
    ],
  }, { view: 'compare', timeSec: 0 });
  assert.match(brief, /Every second: 0: Second reel/);
  assert.match(brief, /Compared: v002/);
  assert.equal(brief.includes('Also open'), false);
});
