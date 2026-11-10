import { normalizeReplyModes } from '../../src/lib/replyModes.js';

const MAX_ENTRIES = 100;
const store = new Map();

export function chatCacheKey(message, focus) {
  const question = String(message || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const ids = [...(focus?.ids || [])].map(String).sort().join(',');
  const t = Math.floor(Number(focus?.timeSec) || 0);
  const modes = normalizeReplyModes(focus?.modes).join(',');
  return `${ids}|${t}|${modes}|${question}`;
}

export function readChatCache(key) {
  if (!store.has(key)) return null;
  const text = store.get(key);
  store.delete(key);
  store.set(key, text);
  return text;
}

export function writeChatCache(key, text) {
  const value = String(text || '');
  if (!value.trim()) return;
  if (store.has(key)) store.delete(key);
  store.set(key, value);
  while (store.size > MAX_ENTRIES) store.delete(store.keys().next().value);
}

export function clearChatCache() {
  store.clear();
}
