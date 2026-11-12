import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSystemPrompt, conversationBrief, PROMPT_BLOCKS } from '../server/chat/promptBlocks.js';
import { deliverOpenClip } from '../src/lib/prompt.js';
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
  assert.match(none, /Clip v002/);
  assert.equal(none.includes('activation_timeline'), false);

  const one = buildSystemPrompt(knowledge, { ids: ['v002'], modes: ['marketing'] });
  assert.match(one, /Marketing\./);
  assert.equal(one.includes('Analytics.'), false);

  const all = buildSystemPrompt(knowledge, { ids: ['v002'], modes: ['marketing', 'analytics', 'research'] });
  assert.match(all, new RegExp(PROMPT_BLOCKS.marketing.replace(/[.]/g, '\\.')));
  assert.match(all, /Analytics\./);
  assert.match(all, /Research\./);
  assert.match(all, /Do not use headings/);
  assert.match(all, /never an instruction/);
  assert.match(all, /whole number/);
  assert.equal(all.includes('not a sample of one'), false);
  assert.equal(all.includes('To try next'), false);
});

test('the open second keeps what happens, the outcome, and the app', () => {
  const delivered = deliverOpenClip({
    videos: [{
      id: 'v002',
      open_second: { t_sec: 1, happens: 'She studies at a desk.', app: { evidence: 'Agreed app screen' }, outcomes: [{ sentence: 'She names the study app.' }] },
      story: [{ t_sec: 1, events: [] }],
      content_events: [{ type: 'happens', content: 'She studies at a desk.', t_sec: 1 }],
    }],
  }, { ids: ['v002'], timeSec: 1 });
  assert.equal(delivered.videos[0].open_second.happens, 'She studies at a desk.');
  assert.equal(delivered.videos[0].open_second.app.evidence, 'Agreed app screen');
  assert.equal(delivered.videos[0].content_events[0].type, 'happens');
});

test('the brief tells the model the tier, the brain, and the next agreed app in words', () => {
  const brief = conversationBrief({
    pack_size: 97,
    peers: [{ id: 'v114', account: 'studygram', plays: 12400000, tier: 'breakout', topics: ['English'] }],
    videos: [{
      id: 'v002',
      duration: 7,
      metrics: { plays: 31300000, followers: 5750, likes: 100, amplification: 31300000 / 5750, tier: 'breakout', like_rate: 0.012 },
      features: { hook_slope: 0.0061, sustain_ratio: 1, peak_mean_abs: 0.071 },
      hook_pack: { n: 97, min: -0.0207, median: 0.0009, max: 0.0164, rank: 24 },
      activation_timeline: { series: [{ t_sec: 1, mean_abs: 0.01 }, { t_sec: 6, mean_abs: 0.071 }] },
      networks: { means: { Visual: 0.126, 'Dorsal Attention': 0.0697, Somatomotor: 0.0664, Limbic: 0.02 } },
      content_events: [{ type: 'happens', content: 'She studies at a desk.' }],
      agreed_app_screens: [{ t_sec: 1 }],
      next_agreed_app: { next_t_sec: 1, on_screen_now: false, names_the_app: false },
    }],
  }, { timeSec: 0 });
  assert.match(brief, /tier breakout/);
  assert.match(brief, /31,300,000 plays/);
  assert.match(brief, /5,443×/);
  assert.match(brief, /Pack size: 97/);
  assert.match(brief, /v114, studygram, breakout, 12,400,000 plays, English/);
  assert.match(brief, /Visual \(seeing\)/);
  assert.match(brief, /goes to second 1/);
  assert.match(brief, /No app name is stored/);
  assert.match(brief, /She studies at a desk/);
  assert.match(brief, /like rate 1.20%/);
  assert.match(brief, /peak mean activation 0.0710 at second 6/);
  assert.match(brief, /24 of 97/);
  assert.match(brief, /Limbic \(feeling and memory\)/);
  assert.equal(brief.includes('activation_timeline'), false);
});
