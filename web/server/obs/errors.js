import { logEvent, safeErrorFields } from './log.js';

const USER_COPY = {
  bad_request: 'That request is not valid.',
  not_found: 'That video is not in your Library.',
  no_library: 'Your Library is not available right now.',
  method_not_allowed: 'That action is not allowed.',
  search_unavailable: 'Search is unavailable. Try again in a moment.',
  library_unavailable: 'Library is unavailable. Try again in a moment.',
  media_unavailable: "This video can't play right now.",
  queue_unavailable: 'The queue is unavailable. Try again in a moment.',
  rate_limited: 'Too many requests. Wait a moment and try again.',
  not_configured: 'Chat is paused in this demo.',
  spend_cap: 'Chat is paused in this demo.',
  payload_too_large: 'That request is too large.',
  empty_message: 'That message is empty.',
  message_too_short: 'That message is too short.',
  message_too_long: 'That message is too long.',
  unknown_route: 'That request was not found.',
  api_handler_failed: 'That request could not be completed.',
  forbidden: "This video can't play right now.",
};

export function errorBody(requestId, error, message) {
  return { requestId, error, message: message || userMessage(error) };
}

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
    ...(expected ? {} : safeErrorFields(err)),
  });
  res.status(status).json({ requestId, error: code, message: known ? err.userMessage : userMessage(code) });
}
