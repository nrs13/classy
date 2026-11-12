import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveChatConfig } from './provider.js';
import { computedAnswer } from './computed.js';
import { applyLenses } from './lenses.js';
import { mockChatAllowed } from './mock.js';

export const CHAT_PAUSED = 'Chat is paused in this demo.';
export const CANNED_ONLY = 'Only the suggested questions are answered in this demo.';
export const REGION_CANNED_NOTICE =
  'Live chat is not available in your region. Pick a question to see an example answer.';

/** EU members, the other EEA countries, Switzerland, and the UK. Free-tier chat stays canned here. */
const RESTRICTED_CHAT_COUNTRIES = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT',
  'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
  'IS', 'LI', 'NO',
  'CH', 'GB',
];

const RESTRICTED = new Set(RESTRICTED_CHAT_COUNTRIES);

export function chatMode(env = process.env) {
  const raw = String(env.CHAT_MODE ?? '').trim().toLowerCase();
  if (raw === 'off' || raw === 'canned' || raw === 'live') return raw;
  return 'off';
}

/** Two-letter country from x-vercel-ip-country. Missing or unusable is empty, which fails closed. */
export function visitorCountry(headers) {
  const raw = headers?.['x-vercel-ip-country'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const code = String(value ?? '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : '';
}

function regionLimitsLive(country) {
  return !country || RESTRICTED.has(country);
}

/** Live becomes canned for a restricted visitor, and when the country header is missing. */
export function effectiveChatMode(env = process.env, country = '') {
  const configured = chatMode(env);
  if (configured === 'live' && regionLimitsLive(country)) {
    const localMock = !country && String(env.CHAT_PROVIDER || '').trim().toLowerCase() === 'mock' && mockChatAllowed(env);
    if (!localMock) return 'canned';
  }
  return configured;
}

export function chatStatus(env = process.env, country = '') {
  const configured = chatMode(env);
  const mode = effectiveChatMode(env, country);
  const { apiKey } = resolveChatConfig(env);
  const ready = mode === 'canned' || (mode === 'live' && Boolean(apiKey));
  const gated = configured === 'live' && mode === 'canned';
  return {
    mode,
    ready,
    privacy: mode === 'live' && ready,
    notice: gated ? REGION_CANNED_NOTICE : '',
    state: 'ok',
    resetAt: null,
  };
}

function norm(text) {
  return String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

const FALLBACK_TYPES = new Set([
  'auth', 'quota', 'timeout', 'server', 'network', 'missing_key',
  'minute_quota', 'day_quota', 'visitor_rate', 'own_daily_cap',
]);

export function liveFallbackText(errorType, message, focus, rows, clip, pack) {
  if (!FALLBACK_TYPES.has(errorType)) return null;
  const stored = matchCanned(message, focus, rows) || computedAnswer(message, clip, pack);
  if (!stored) return CHAT_PAUSED;
  return applyLenses(stored, focus?.modes);
}

export function matchCanned(message, focus, rows = readCanned()) {
  const question = norm(message);
  if (!question) return null;
  const ids = new Set(Array.isArray(focus?.ids) ? focus.ids : []);
  for (const row of rows) {
    if (!row || typeof row.answer !== 'string' || !row.answer.trim()) continue;
    if (row.videoId && !ids.has(row.videoId)) continue;
    if (norm(row.question) === question) return row.answer;
  }
  return null;
}

function readCanned() {
  const path = join(dirname(fileURLToPath(import.meta.url)), 'canned.json');
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
