export const KINDS = [
  { id: '', label: 'Anything' },
  { id: 'said', label: 'Said' },
  { id: 'on_screen', label: 'On screen' },
  { id: 'scene', label: 'Scene' },
];

/** Retrieval-only: how a result matched the query. Never a performance score. */
export const MATCH_LABEL = {
  exact: 'Exact words',
  words: 'Words match',
  words_and_meaning: 'Words match',
  meaning: 'Similar meaning',
};

export const MAX_QUERY = 300;
export const COUNT_FROM = 280;

export const EMPTY_COPY = 'Nothing in your Library matches that.';

export function compareKeepsLibrary(mode, { status, busy, refining, resultCount }) {
  return mode === 'compare' && status === 'done' && !busy && !refining && resultCount === 0;
}
export const EMPTY_HINT = 'Try fewer words, another language, or describe what happens in the video.';
export const ERROR_COPY = 'Search is unavailable. Try again in a moment.';
export const EXACT_COPY = 'Showing exact matches only right now.';

const ERROR_KIND_COPY = {
  rate: 'Too many searches. Try again in a few seconds.',
  offline: 'You are offline. Search comes back when you reconnect.',
  unavailable: 'Your Library is unavailable right now. Try again in a moment.',
};

export function errorCopy(error) {
  if (!error) return '';
  return ERROR_KIND_COPY[error.kind] || error.message || ERROR_COPY;
}

/** What the failure panel may render. A missing error must not throw. */
export function searchFailureView(error) {
  return {
    message: errorCopy(error) || ERROR_COPY,
    retry: error?.kind !== 'offline',
  };
}

/**
 * A new search starts while the previous failure is still on screen.
 * Drop the error in the same update, or the panel reads a null error and crashes.
 */
export function beginSearchState(prev, forKey) {
  const results = Array.isArray(prev?.results) ? prev.results : [];
  return {
    ...prev,
    status: prev?.status === 'error' ? 'loading' : prev?.status,
    busy: true,
    stale: results.length > 0,
    error: null,
    forKey,
  };
}

/** Curated starting points in several languages; each one finds its video first. */
export const CURATED_EXAMPLES = [
  { q: 'how was the math exam', lang: 'en' },
  { q: 'chica bailando en el pasillo del colegio', lang: 'es' },
  { q: 'Wie viele Nullen hat eine Milliarde?', lang: 'de' },
  { q: 'テストの準備ができているか聞かれて焦る女性', lang: 'ja' },
  { q: 'une lycéenne stressée par le bac de physique-chimie', lang: 'fr' },
  { q: 'japanese video about earning money from your notes', lang: 'en' },
];

export function fmtTime(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function fmtCount(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return '';
  if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1).replace(/\.0$/, '')}K`;
  return String(Math.round(v));
}

/** "Said at 0:12", "On screen at 0:10", "Described in scene at 0:04", "About the whole video". */
export function whyLine(moment) {
  const at = fmtTime(moment?.tSec);
  if (moment?.kind === 'video') return 'About the whole video';
  if (moment?.kind === 'on_screen') return `On screen at ${at}`;
  if (moment?.kind === 'scene') return `Described in scene at ${at}`;
  return `Said at ${at}`;
}

/** Two-letter language for the filter chip, from a tag such as "es-ES". */
export function langCode(tag) {
  return String(tag || '').slice(0, 2).toLowerCase();
}

const LANG_NAME = {
  de: 'German',
  el: 'Greek',
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  it: 'Italian',
  ja: 'Japanese',
  ko: 'Korean',
  pl: 'Polish',
  pt: 'Portuguese',
  tl: 'Filipino',
  tr: 'Turkish',
  zh: 'Chinese',
};

export function langName(code) {
  return LANG_NAME[code] || String(code || '').toUpperCase();
}

export function resultCounts(results) {
  const videos = results.length;
  const moments = results.reduce((sum, r) => sum + (r.momentCount || 1 + (r.more?.length || 0)), 0);
  return { videos, moments };
}

export function countLine({ videos, moments }) {
  const v = `${videos} ${videos === 1 ? 'video' : 'videos'}`;
  const m = `${moments} ${moments === 1 ? 'moment' : 'moments'}`;
  return `${v} · ${m}`;
}

const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/u;
const MIN_WORD = 4;
/** Long function words in the Library's languages: marking them shows no real match. */
const FILLER = new Set(
  (
    'about also been does from have here into just like more only over some than that them then there these ' +
    'they this very what when where which while will with would your ' +
    'algo ante como cuando desde donde entre esta este esto estos hace hasta para pero porque sobre tiene todo ' +
    'aqui aquí cada mais mesmo muito nossa nosso onde pela pelo quando você voce ' +
    'aber alle auch dann dass denn eine einem einen einer haben hier mehr nach nicht noch oder sein sich sind ' +
    'über uber weil wenn wird ' +
    'avec dans elle mais nous pour sans sont tout vous cette ' +
    'anche come della delle degli nella sono questo quella'
  ).split(' '),
);

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A meaning-only match is not marked, because those words are not the words on screen. */
export function highlightParts(text, query, match) {
  const source = String(text || '');
  if (match === 'meaning') return [{ text: source, hit: false }];
  const needles = [];
  for (const one of Array.isArray(query) ? query : [query]) {
    const phrase = String(one || '')
      .replace(/"/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const words = phrase
      .split(' ')
      .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
      .filter((w) => [...w].length >= (CJK.test(w) ? 2 : MIN_WORD) && !FILLER.has(w.toLowerCase()));
    needles.push(phrase, ...words);
  }
  const unique = [...new Set(needles.filter((w) => [...w].length >= 2))].sort((a, b) => b.length - a.length);
  return markNeedles(source, unique);
}

function markNeedles(source, needles) {
  if (!needles.length) return [{ text: source, hit: false }];
  const alternatives = needles.map((w) =>
    CJK.test(w) ? escapeRe(w) : `(?<![\\p{L}\\p{N}])${escapeRe(w)}(?![\\p{L}\\p{N}])`,
  );
  const pattern = new RegExp(`(${alternatives.join('|')})`, 'iu');
  return source
    .split(pattern)
    .map((part, index) => ({ text: part, hit: index % 2 === 1 }))
    .filter((part) => part.text !== '');
}

const RECENT_KEY = 'classy.search.recent';
const RECENT_MAX = 6;

export function loadRecent() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(list) ? list.filter((q) => typeof q === 'string' && q.trim()).slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

function storeRecent(list) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
  } catch {
    /* private mode: recent searches are a convenience */
  }
}

export function addRecent(list, q) {
  const clean = String(q || '').trim();
  if (!clean) return list;
  const next = [clean, ...list.filter((item) => item.toLowerCase() !== clean.toLowerCase())].slice(0, RECENT_MAX);
  storeRecent(next);
  return next;
}

export function dropRecent(list, q) {
  const next = list.filter((item) => item !== q);
  storeRecent(next);
  return next;
}

const REEL_ID = /^v\d+$/;

function screenFromPath(pathname, legacyView) {
  const path = String(pathname || '/').replace(/\/+$/, '') || '/';
  if (path === '/search' || legacyView === 'search') return 'search';
  if (path === '/compare' || legacyView === 'compare') return 'compare';
  return '';
}

export function parseReels(raw) {
  const ids = [];
  for (const part of String(raw || '').split(',')) {
    const id = part.trim();
    if (!REEL_ID.test(id) || ids.includes(id)) continue;
    ids.push(id);
    if (ids.length === 4) break;
  }
  return ids;
}

/** Screen is the path (`/`, `/search`, `/compare`). Filters stay in the query. */
export function searchFromUrl(href) {
  const url = new URL(href, 'http://localhost');
  const view = screenFromPath(url.pathname, url.searchParams.get('view') || '');
  const kind = url.searchParams.get('kind');
  return {
    view,
    q: (url.searchParams.get('q') || '').slice(0, MAX_QUERY),
    filters: {
      lang: url.searchParams.get('lang') || '',
      field: KINDS.some((k) => k.id && k.id === kind) ? kind : '',
      account: url.searchParams.get('account') || '',
    },
    reels: parseReels(url.searchParams.get('reels')),
  };
}

export function searchToUrl(href, { view, q = '', filters = {}, reels = [] } = {}) {
  const url = new URL(href, 'http://localhost');
  const screen = view === 'search' || view === 'compare' ? view : '';
  url.pathname = screen === 'search' ? '/search' : screen === 'compare' ? '/compare' : '/';
  for (const key of ['view', 'q', 'lang', 'kind', 'account', 'reels']) url.searchParams.delete(key);
  if (screen === 'search') {
    if (String(q).trim()) url.searchParams.set('q', String(q).trim());
    if (filters.lang) url.searchParams.set('lang', filters.lang);
    if (filters.field) url.searchParams.set('kind', filters.field);
    if (filters.account) url.searchParams.set('account', filters.account);
  }
  if (screen === 'compare') {
    const ids = parseReels(reels.join(','));
    if (ids.length) url.searchParams.set('reels', ids.join(','));
  }
  const query = url.searchParams.toString();
  return `${url.pathname}${query ? `?${query}` : ''}${url.hash}`;
}
