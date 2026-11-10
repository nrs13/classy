/** True when a send may start. A second click in the same turn is refused. */
export function acceptSend(inFlight, text) {
  if (inFlight) return false;
  return Boolean(String(text ?? '').trim());
}
