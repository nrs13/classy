import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asksToFind, findHits } from '../server/chat/find.js';
import { wantsDirectory, wantsFullTimeline } from '../server/chat/knowledge.js';
import { conversationBrief } from '../server/chat/promptBlocks.js';

test('the 97-reel directory and full seconds load only when the question needs them', () => {
  assert.equal(wantsDirectory('how many plays does this have?', 'explore'), false);
  assert.equal(wantsFullTimeline('how many plays does this have?'), false);
  assert.equal(wantsDirectory('what is amplification?', 'explore'), false);
  assert.equal(wantsFullTimeline('what is amplification?'), false);
  assert.equal(wantsDirectory('find reels about cooking', 'explore'), false);
  assert.equal(wantsFullTimeline('find reels about cooking'), false);
  assert.equal(wantsDirectory('why did this work?', 'explore'), false);
  assert.equal(wantsFullTimeline('why did this work?'), true);
  assert.equal(wantsFullTimeline('How does the opening earn the attention?'), true);
  assert.equal(wantsDirectory('can you suggest videos to take inspo from', 'explore'), true);
  assert.equal(wantsDirectory('how do these two differ?', 'compare'), false);
});

test('find wording is the only kind that may search', () => {
  assert.equal(asksToFind('find reels about cooking'), true);
  assert.equal(asksToFind('Show me reels with a desk'), true);
  assert.equal(asksToFind('which reels mention exams'), true);
  assert.equal(asksToFind('any reels about a study habit?'), true);
  assert.equal(asksToFind('what is a hook?'), false);
  assert.equal(asksToFind('why did this work?'), false);
  assert.equal(asksToFind('how many plays does this have?'), false);
});

test('a find question calls search with understanding off and keeps id, account, and line', async () => {
  const seen = [];
  const hits = await findHits('find reels about cooking', async (options) => {
    seen.push(options);
    return {
      results: [{
        videoId: 'v026',
        account: 'studygram',
        best: { quote: 'Three boys dance with a caption.' },
        sprite: { url: 'https://example.invalid/secret' },
      }],
    };
  });
  assert.deepEqual(seen, [{ q: 'find reels about cooking', understand: false, limit: 5 }]);
  assert.deepEqual(hits, [{ id: 'v026', account: 'studygram', line: 'Three boys dance with a caption.' }]);
  assert.equal(JSON.stringify(hits).includes('example.invalid'), false);
});

test('a question that is not a find does not call search', async () => {
  let calls = 0;
  const hits = await findHits('what is a hook?', async () => {
    calls += 1;
    return { results: [] };
  });
  assert.equal(calls, 0);
  assert.deepEqual(hits, []);
});

test('search hits are named in the brief, and none stays explicit', () => {
  const video = { id: 'v002', metrics: { plays: 1 }, features: {} };
  const found = conversationBrief({
    videos: [video],
    search: [{ id: 'v026', account: 'studygram', line: 'Three boys dance.' }],
  }, { timeSec: 0, view: 'explore' });
  assert.match(found, /Search hit: v026, studygram, Three boys dance/);
  const empty = conversationBrief({ videos: [video], search: [] }, { timeSec: 0, view: 'explore' });
  assert.match(empty, /Search hits: none/);
  const plain = conversationBrief({ videos: [video] }, { timeSec: 0, view: 'explore' });
  assert.equal(plain.includes('Search hit'), false);
});
