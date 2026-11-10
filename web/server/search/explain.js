import { MEANING_LANES, matchOf, WORD_LANES } from './rank.js';

const KIND = {
  segment: 'said',
  speech: 'said',
  ask: 'said',
  text_on_screen: 'on_screen',
  scene: 'scene',
  evidence: 'scene',
  topic: 'scene',
  keyword: 'scene',
  video: 'video',
};

export function kindOf(field) {
  return KIND[field] || 'scene';
}

/**
 * Retrieval strength only. Never a performance or virality score.
 * strong: the whole query appears, or both lanes found it.
 * good:   one lane ranks its video in the top 5, or the meaning match is close to this
 *         query's best (cosine scales differ between queries, so it is relative).
 */
export function strengthOf(moment) {
  const lanes = moment.lanes || {};
  const match = matchOf(moment);
  if (match === 'exact' || match === 'words_and_meaning') return 'strong';
  const rankOf = (lane) => lane?.videoRank ?? lane?.rank ?? Infinity;
  const best = Math.min(...[...WORD_LANES, ...MEANING_LANES].map((name) => rankOf(lanes[name])));
  const relative = Math.max(...MEANING_LANES.map((name) => lanes[name]?.relative ?? 0));
  if (best <= 5 || relative >= 0.92) return 'good';
  return 'partial';
}

/** Content Understanding evidence prefixes each line with its segment, e.g. "00:00:02.030-00:00:06.110:". */
const TIME_RANGE = /\b\d{2}:\d{2}:\d{2}\.\d{3}-\d{2}:\d{2}:\d{2}\.\d{3}:\s*/g;

export function trimQuote(text, max = 220) {
  const clean = String(text || '').replace(TIME_RANGE, ' ').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${cut.slice(0, space > max * 0.6 ? space : max)}…`;
}

function lastSentence(text) {
  const parts = String(text || '')
    .split(/(?<=[.!?。？！])\s+/)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts[parts.length - 1] || '';
}

function firstSentence(text) {
  const parts = String(text || '')
    .split(/(?<=[.!?。？！])\s+/)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts[0] || '';
}

/** One line before and after, from stored context or the speech around the moment. */
function words(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Rolling transcripts repeat text: a context line that the quote already shows adds nothing. */
export function repeatsQuote(line, quote) {
  const a = words(line);
  const b = words(quote);
  if (!a || !b) return false;
  if (b.includes(a) || a.includes(b)) return true;
  const head = (text) => text.split(' ').slice(0, 6).join(' ');
  const aHead = head(a);
  const bHead = head(b);
  return (aHead.split(' ').length >= 4 && b.includes(aHead)) || (bHead.split(' ').length >= 4 && a.includes(bHead));
}

export function contextLines(moment, window = [], radius = 6) {
  if (moment.context && (moment.context.before || moment.context.after)) {
    const keep = (line) => (line && !repeatsQuote(line, moment.text) ? trimQuote(line, 160) : '');
    return { before: keep(moment.context.before), after: keep(moment.context.after) };
  }
  const quote = String(moment.text || '');
  const start = moment.tSec;
  const end = moment.endSec ?? moment.tSec;
  let before = '';
  let after = '';
  for (const row of window) {
    const speech = String(row.speech || '').trim();
    if (!speech || row.t_sec < start - radius || row.t_sec > end + radius) continue;
    if (row.t_sec < start) {
      const line = lastSentence(speech);
      if (line && !repeatsQuote(line, quote)) before = line;
    } else if (row.t_sec > end && !after) {
      const line = firstSentence(speech);
      if (line && !repeatsQuote(line, quote)) after = line;
    }
  }
  return { before: trimQuote(before, 160), after: trimQuote(after, 160) };
}

function speakerAt(moment, window = []) {
  if (moment.speaker) return moment.speaker;
  if (kindOf(moment.field) !== 'said') return '';
  const row = window.find((r) => r.t_sec === moment.tSec);
  return row?.speaker || '';
}

export function explainMoment(moment, { window = [], speakers = 0 } = {}) {
  const { before, after } = contextLines(moment, window);
  const speaker = speakers > 1 ? speakerAt(moment, window) : '';
  return {
    tSec: moment.tSec,
    endSec: moment.endSec ?? null,
    kind: kindOf(moment.field),
    quote: trimQuote(moment.text),
    before,
    after,
    speaker: speaker || null,
    strength: strengthOf(moment),
    match: matchOf(moment),
  };
}
