import { normalizeReplyModes, REPLY_MODES } from '../../src/lib/replyModes.js';

const VOICE = {
  marketing: 'Hook and audience.',
  analytics: 'Numbers and ranks.',
  research: 'Method and caveats.',
};

const HOOK = /\bhook\b/i;
const AUDIENCE = /\bfollowers?\b|\btier\b|\bbreakout\b|\baudience\b/i;
const RANK = /\branks?\b|\bhighest\b|\blowest\b|\bmedian\b|\d+(?:st|nd|rd|th)\b/i;
const METHOD = /\bdivided by\b|\bshare of\b|\bpredicted\b|\bencoding\b/i;
const CAVEAT = /\bdoes not\b|\bdo not\b|\bnot a\b|\bnot from\b|\bcaused\b|\bcause\b|\bpack is\b|\bN=/i;

export function storedSentences(text) {
  return String(text || '').split(/(?<=\.)\s+/).map((sentence) => sentence.trim()).filter(Boolean);
}

function numberCount(sentence) {
  return (sentence.match(/\d+(?:\.\d+)?/g) || []).length;
}

function firstIndex(sentences, pred) {
  return sentences.findIndex(pred);
}

function leadIndex(sentences, id) {
  const hookOrAudience = firstIndex(sentences, (sentence) => HOOK.test(sentence) || AUDIENCE.test(sentence));
  const rank = firstIndex(sentences, (sentence) => RANK.test(sentence));
  const numbered = sentences
    .map((sentence, index) => ({ index, count: numberCount(sentence) }))
    .filter((row) => row.count > 0)
    .sort((a, b) => b.count - a.count || a.index - b.index);
  const method = sentences
    .map((sentence, index) => (METHOD.test(sentence) || CAVEAT.test(sentence) ? index : -1))
    .filter((index) => index >= 0);

  if (id === 'marketing') return hookOrAudience;
  if (id === 'analytics') {
    if (rank >= 0 && rank !== hookOrAudience) return rank;
    const other = numbered.find((row) => row.index !== hookOrAudience);
    if (other) return other.index;
    return numbered[0]?.index ?? rank;
  }
  const other = method.find((index) => index !== hookOrAudience && index !== leadIndex(sentences, 'analytics'));
  if (other !== undefined) return other;
  return method[0] ?? -1;
}

export function arrangeForLens(text, id) {
  const sentences = storedSentences(text);
  const lead = leadIndex(sentences, id);
  if (lead <= 0) return sentences.join(' ');
  return [sentences[lead], ...sentences.filter((_, index) => index !== lead)].join(' ');
}

export function applyLenses(base, modes) {
  const text = String(base || '');
  const selected = normalizeReplyModes(modes);
  if (!text || !selected.length) return text;
  return selected.map((id) => {
    const label = REPLY_MODES.find((mode) => mode.id === id).label;
    return `${label}\n${VOICE[id]}\n${arrangeForLens(text, id)}`;
  }).join('\n\n');
}
