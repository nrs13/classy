/** True when a send may start. A second click in the same turn is refused. */
export function acceptSend(inFlight, text) {
  if (inFlight) return false;
  return Boolean(String(text ?? '').trim());
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
