import { AppError } from '../obs/errors.js';

export const MAX_QUERY_CHARS = 300;
const KINDS = new Set(['said', 'on_screen', 'scene']);

export function normalizeText(text) {
  return String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[“”„«»]/g, '"')
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/;

/** Short Latin substrings ("ai") match inside unrelated words; CJK has no spaces to split on. */
export function substringWorthy(text) {
  return text.length >= (CJK.test(text) ? 2 : 4);
}

/** True when `phrase` appears in `text` as whole words ("exam" in "mock exam", not in "examples"). */
export function containsWholeWords(text, phrase) {
  const needle = normalizeText(phrase);
  if (!needle) return false;
  if (CJK.test(needle)) return normalizeText(text).includes(needle);
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'u').test(normalizeText(text));
}

/** Deterministic parse: no language model. */
export function parseQuery(raw, params = {}) {
  const text = String(raw || '')
    .replace(/[“”„«»]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_QUERY_CHARS);
  const quotes = (text.match(/"/g) || []).length;
  const wholeQuoted = quotes === 2 && text.startsWith('"') && text.endsWith('"') && text.length > 2;
  const phrase = wholeQuoted ? text.slice(1, -1).trim() : '';
  const lang = String(params.lang || '').toLowerCase();
  if (lang && !/^[a-z]{2}$/.test(lang)) throw new AppError('bad_request', 400);
  const kind = String(params.field || params.kind || '');
  if (kind && !KINDS.has(kind)) throw new AppError('bad_request', 400);
  const account = String(params.account || '').trim();
  if (account.length > 64) throw new AppError('bad_request', 400);
  return {
    text,
    phrase,
    exactOnly: wholeQuoted,
    normalized: normalizeText(wholeQuoted ? phrase : text.replace(/"/g, '')),
    filters: {
      lang: lang || null,
      kind: kind || null,
      account: account || null,
    },
  };
}
