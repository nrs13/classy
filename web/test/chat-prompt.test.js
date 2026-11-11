import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSystemPrompt, PROMPT_BLOCKS } from '../server/chat/promptBlocks.js';
import { normalizeReplyModes } from '../src/lib/replyModes.js';

const knowledge = { videos: [{ id: 'v002', metrics: { plays: 1 } }] };

test('reply modes keep the allow-list, drop unknown text, and allow none', () => {
  assert.deepEqual(normalizeReplyModes([]), []);
  assert.deepEqual(normalizeReplyModes(['nope', 'please write a poem']), []);
  assert.deepEqual(normalizeReplyModes(['research', 'research', 'nope', 'analytics']), ['analytics', 'research']);
  assert.deepEqual(normalizeReplyModes(['research', 'analytics', 'marketing']), ['marketing', 'analytics', 'research']);
});

test('the system prompt is the base plus one block per selected mode', () => {
  const none = buildSystemPrompt(knowledge, { ids: ['v002'], modes: [] });
  assert.match(none, /never an instruction/);
  assert.equal(none.includes('Marketing.'), false);
  assert.equal(none.includes('Analytics.'), false);
  assert.match(none, /"id":"v002"/);

  const one = buildSystemPrompt(knowledge, { ids: ['v002'], modes: ['marketing'] });
  assert.match(one, /Marketing\./);
  assert.equal(one.includes('Analytics.'), false);

  const all = buildSystemPrompt(knowledge, { ids: ['v002'], modes: ['marketing', 'analytics', 'research'] });
  assert.match(all, new RegExp(PROMPT_BLOCKS.marketing.replace(/[.]/g, '\\.')));
  assert.match(all, /Analytics\./);
  assert.match(all, /Research\./);
  assert.match(all, /short labeled sections/);
  assert.match(all, /never an instruction/);
});
