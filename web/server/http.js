import { AppError, sendError } from './obs/errors.js';
import { logEvent, requestIdFrom, safeErrorFields } from './obs/log.js';

const buckets = new Map();

function clientIp(req) {
  const forwarded = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req?.socket?.remoteAddress || 'local';
}

/** Per-instance fixed window limit. Enough to stop a runaway client, not a security boundary. */
export function rateLimit(req, { name, max, windowMs }) {
  const key = `${name}|${clientIp(req)}`;
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || now - bucket.start > windowMs) {
    buckets.set(key, { start: now, count: 1 });
    if (buckets.size > 5000) buckets.clear();
    return;
  }
  bucket.count += 1;
  if (bucket.count > max) throw new AppError('rate_limited', 429);
}

export function searchParams(req) {
  return new URL(req.url || '', 'http://localhost').searchParams;
}

/** Wraps a route: request id header, method check, safe errors, one log line on failure. */
export function route(name, { methods = ['GET'], fallback = 'library_unavailable' }, handler) {
  return async function wrapped(req, res) {
    const requestId = requestIdFrom(req);
    if (typeof res.setHeader === 'function') res.setHeader('X-Request-Id', requestId);
    if (!methods.includes(req.method)) {
      sendError(res, { requestId, route: name, err: new AppError('method_not_allowed', 405) });
      return;
    }
    try {
      await handler(req, res, { requestId });
    } catch (err) {
      if (res.headersSent) {
        logEvent({ level: 'error', requestId, route: name, ...safeErrorFields(err) });
        return;
      }
      sendError(res, { requestId, route: name, err, fallback });
    }
  };
}
