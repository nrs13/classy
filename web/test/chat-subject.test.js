import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answerSubject } from '../src/lib/answerSubject.js';
import { windowTimeline } from '../server/chat/knowledge.js';
import { conversationBrief } from '../server/chat/promptBlocks.js';

test('the next answer names the open reel and refuses a one-reel comparison', () => {
  const reels = [
    { id: 'v001', account: 'Ada' },
    { id: 'v002', account: 'Bea' },
    { id: 'v003', account: 'Ada' },
  ];
  assert.equal(answerSubject('explore', reels, ['v002']).text, 'Answering Bea');
  assert.equal(answerSubject('search', reels, ['v001']).text, 'Answering Ada (v001)');
  assert.equal(answerSubject('explore', reels, []).ready, false);
  const one = answerSubject('compare', reels, ['v002']);
  assert.equal(one.ready, false);
  assert.equal(one.text, 'Another reel is needed before Classy can compare.');
  const set = answerSubject('compare', reels, ['v001', 'v002']);
  assert.equal(set.ready, true);
  assert.equal(set.text, 'Answering Ada (v001), Bea');
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
