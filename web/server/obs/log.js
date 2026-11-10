import { randomUUID } from 'node:crypto';

export function newRequestId() {
  return randomUUID().replace(/-/g, '').slice(0, 16);
}

export function requestIdFrom(req) {
  const given = String(req?.headers?.['x-request-id'] || '');
  return /^[A-Za-z0-9_-]{8,64}$/.test(given) ? given : newRequestId();
}

/** One JSON line per event. Never pass secrets or raw user text longer than the cap. */
export function logEvent(event) {
  if (process.env.CLASSY_LOG === 'off') return;
  const line = { at: new Date().toISOString(), ...event };
  process.stdout.write(`${JSON.stringify(line)}\n`);
}
