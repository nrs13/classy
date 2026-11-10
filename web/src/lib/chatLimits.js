export const MAX_MESSAGE_CHARS = 4000;
export const MAX_HISTORY_MESSAGES = 40;

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

/** True when a send may start. A second click in the same turn is refused. */
export function acceptSend(inFlight, text) {
  if (inFlight) return false;
  const q = String(text ?? '').trim();
  return q.length > 0 && !messageTooLong(q);
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
