import { logEvent } from './log.js';

const USER_COPY = {
  bad_request: 'That request is not valid.',
  not_found: 'That video is not in your Library.',
  no_library: 'Your Library is not available right now.',
  method_not_allowed: 'That action is not allowed.',
  search_unavailable: 'Search is unavailable. Try again in a moment.',
  library_unavailable: 'Your Library is unavailable. Try again in a moment.',
  media_unavailable: "This video can't play right now.",
  queue_unavailable: 'The queue is unavailable. Try again in a moment.',
  rate_limited: 'Too many requests. Wait a moment and try again.',
};

export class AppError extends Error {
  constructor(code, status = 400, message = '') {
    super(message || code);
    this.code = code;
    this.status = status;
    this.userMessage = message || USER_COPY[code] || USER_COPY.bad_request;
  }
}

export function userMessage(code) {
  return USER_COPY[code] || USER_COPY.bad_request;
}

/** Map any thrown value to a safe response. Internal detail goes to the log only. */
export function sendError(res, { requestId, route, err, fallback }) {
  const known = err instanceof AppError;
  const status = known ? err.status : 503;
  const code = known ? err.code : fallback;
  const expected = known && status < 500;
  logEvent({
    level: expected ? 'warn' : 'error',
    requestId,
    route,
    code,
    status,
    ...(expected ? {} : { error: String(err?.stack || err?.message || err).slice(0, 2000) }),
  });
  res.status(status).json({ requestId, error: code, message: known ? err.userMessage : userMessage(code) });
}
