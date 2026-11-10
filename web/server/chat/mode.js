import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveChatConfig } from './provider.js';

export const CHAT_PAUSED = 'Chat is paused in this demo.';
export const CANNED_ONLY = 'Only the suggested questions are answered in this demo.';

export function chatMode(env = process.env) {
  const raw = String(env.CHAT_MODE ?? '').trim().toLowerCase();
  if (raw === 'off' || raw === 'canned' || raw === 'live') return raw;
  return 'off';
}

export function chatStatus(env = process.env) {
  const mode = chatMode(env);
  const { apiKey } = resolveChatConfig(env);
  const ready = mode === 'canned' || (mode === 'live' && Boolean(apiKey));
  return {
    mode,
    ready,
    privacy: mode === 'live' && ready,
  };
}

function norm(text) {
  return String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
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
