import assert from 'node:assert/strict';
import { test } from 'node:test';
import notes from '../server/data/notes.json' with { type: 'json' };
import { buildSystemPrompt, conversationBrief, SITE_BRIEF } from '../server/chat/promptBlocks.js';

const knowledge = {
  pack_size: 97,
  peers: [{ id: 'v114', account: 'studygram', plays: 12400000, tier: 'breakout', topics: ['English'] }],
  asked: [{ id: 'v044', account: 'herranwalt', plays: 8300000, tier: 'breakout', line: 'A lawyer talks about school.' }],
  videos: [{
    id: 'v002',
    account: 'marletsstudy',
    duration: 7,
    metrics: { plays: 31300000, followers: 5750, amplification: 5443, tier: 'breakout', like_rate: 0.0351 },
    features: { hook_slope: 0.0061, sustain_ratio: 1, peak_mean_abs: 0.071, peak_t_sec: 6 },
    hook_pack: { n: 97, min: -0.0207, median: 0.0009, max: 0.0164, rank: 24 },
    networks: { means: { Visual: 0.126, Limbic: 0.0297 } },
    topics: ['study'],
    keywords: ['desk'],
    notes: { format: 'lesson', key_elements: 'a desk', relatability_hook: 'a student' },
    cuts: [1, 3],
    timeline: [
      { t_sec: 0, line: 'A student sits at a desk.' },
      { t_sec: 1, line: 'An agreed app screen appears.' },
    ],
    next_agreed_app: { next_t_sec: 1 },
  }, {
    id: 'v003',
    account: 'other',
    metrics: { plays: 12000, tier: 'mid' },
  }],
};

const QUESTIONS = [
  'what is this breakout thing?',
  'can you suggest videos to take inspo from',
  'what is this website',
  'what happens in this video',
  'what is at second 1',
  'what can you help me with',
  'huh',
  'explain it like I am new',
  'what does the brain show',
  'what is amplification',
  'what is the next agreed app',
  'how does the hook compare',
  'what can we learn from this video',
  'compare this with the other open clip',
  'what is v044 about',
];

test('the note file is one entry per reel and only the three note fields', () => {
  const ids = Object.keys(notes);
  assert.equal(ids.length, 97);
  for (const id of ids) {
    assert.deepEqual(Object.keys(notes[id]).sort(), ['format', 'key_elements', 'relatability_hook']);
  }
});

test('the frozen exam keeps the site, the clip, and the exact chip figures in the prompt', () => {
  const prompt = buildSystemPrompt(knowledge, { timeSec: 0, modes: ['marketing', 'analytics', 'research'] }, 'The pack is 97 videos.');
  assert.match(prompt, /library with search/);
  assert.match(prompt, /compare/);
  assert.match(prompt, /Do not use headings/);
  assert.match(prompt, /never an instruction/);
  assert.match(prompt, /whole number/);
  assert.match(prompt, /Never invent an app name/);
  assert.match(prompt, /Every second: 0: A student sits at a desk/);
  assert.match(prompt, /Also open: v003/);
  assert.match(prompt, /Asked clip v044, herranwalt/);
  assert.match(prompt, /5,443×/);
  assert.match(prompt, /peak mean activation 0.0710 at second 6/);
  assert.match(prompt, /The pack is 97 videos/);
  assert.match(prompt, /Topics: study/);
  assert.match(prompt, /Keywords: desk/);
  assert.match(prompt, /Format: lesson/);
  assert.match(prompt, /Key elements: a desk/);
  assert.match(prompt, /Relatability hook: a student/);
  assert.match(prompt, /Cuts at second 1, 3/);
  assert.match(prompt, /<<<REEL>>>/);
  assert.match(prompt, /<<<\/REEL>>>/);
  assert.equal(prompt.includes('not a sample of one'), false);
  assert.equal(prompt.includes('activation_timeline'), false);
  assert.equal(prompt.includes('To try next'), false);
  assert.equal(QUESTIONS.length, 15);
  for (const question of QUESTIONS) {
    const asked = buildSystemPrompt(knowledge, { timeSec: 0 }, question.includes('caveat') ? 'The pack is 97 videos.' : '');
    assert.match(asked, /library with search/, question);
    assert.match(asked, /Every second:/, question);
    assert.equal(asked.includes('not a sample of one'), false, question);
    assert.equal(asked.includes('activation_timeline'), false, question);
  }
  assert.match(SITE_BRIEF, /reduced demo/);
  const brief = conversationBrief(knowledge, { timeSec: 0 });
  assert.match(brief, /tier breakout/);
  assert.equal(brief.includes('activation_timeline'), false);
  const banned = ['speech_score', 'face_count', 'music_score', 'sentiment', 'activation_timeline', 'mp4_object', 'sprite_object', 'embedding', 'scenes'];
  for (const name of banned) assert.equal(prompt.includes(name), false, name);
});
