export const MAX_MESSAGE_CHARS = 4000;
const MIN_MESSAGE_CHARS = 8;
export const MAX_HISTORY_MESSAGES = 40;
export const MAX_CHAT_BODY_BYTES = 512 * 1024;
export const CHAT_COOLDOWN_MS = 8000;

/** Code points, so an emoji counts as one and is never split. */
export function messageLength(text) {
  return Array.from(String(text ?? '')).length;
}

export function capMessage(text) {
  const chars = Array.from(String(text ?? ''));
  if (chars.length <= MAX_MESSAGE_CHARS) return String(text ?? '');
  return chars.slice(0, MAX_MESSAGE_CHARS).join('');
}

export function messageTooLong(text) {
  return messageLength(String(text ?? '').trim()) > MAX_MESSAGE_CHARS;
}

export function messageTooShort(text) {
  const q = String(text ?? '').trim();
  return messageLength(q) > 0 && messageLength(q) < MIN_MESSAGE_CHARS;
}

/** True when a send may start. A second click, a short note, or a cooldown is refused. */
export function acceptSend(inFlight, text, now = 0, lastSentAt = 0) {
  if (inFlight) return false;
  if (lastSentAt && now - lastSentAt < CHAT_COOLDOWN_MS) return false;
  const q = String(text ?? '').trim();
  return messageLength(q) >= MIN_MESSAGE_CHARS && !messageTooLong(q);
}

/** Drop a reply that was cancelled before any text arrived. */
export function dropUnfinishedReply(messages) {
  const copy = Array.isArray(messages) ? messages.slice() : [];
  const last = copy[copy.length - 1];
  if (last?.role === 'assistant' && !String(last.text || '').trim()) copy.pop();
  return copy;
}

/** The user turn a Retry should send again, after dropping a failed reply. */
export function retryTurn(messages) {
  const copy = Array.isArray(messages) ? messages.slice() : [];
  while (copy.length && copy[copy.length - 1]?.role === 'assistant' && copy[copy.length - 1]?.error) {
    copy.pop();
  }
  const last = copy[copy.length - 1];
  if (!last || last.role !== 'user' || !String(last.text || '').trim()) return null;
  return { text: String(last.text), prior: copy.slice(0, -1) };
}
