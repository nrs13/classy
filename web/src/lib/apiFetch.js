import { requestIdFromResponse } from './requestId.js';

const DEFAULT_TIMEOUT_MS = 15_000;

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function backoff(attempt) {
  const base = 200 * (2 ** attempt);
  return base * (0.5 + Math.random() * 0.5);
}

/**
 * Shared fetch for API calls. GET may be retried twice. Other methods are not.
 * A 4xx response is returned as-is. Retry-After is honored.
 */
export async function apiFetch(url, options = {}) {
  const {
    method = 'GET',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
    retries,
    headers,
    body,
  } = options;
  const verb = String(method || 'GET').toUpperCase();
  const extra = verb === 'GET' ? (retries ?? 2) : 0;
  let lastError;
  for (let attempt = 0; attempt <= extra; attempt += 1) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onAbort);
    try {
      const res = await fetch(url, { method: verb, headers, body, signal: ctrl.signal });
      requestIdFromResponse(res);
      if (res.status >= 400 && res.status < 500) return res;
      if (res.ok || verb !== 'GET' || attempt === extra) return res;
      const retryAfter = Number(res.headers.get('retry-after'));
      const delay = Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1000 : backoff(attempt);
      await wait(delay, signal);
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError' && signal?.aborted) {
        const aborted = new Error('aborted');
        aborted.name = 'AbortError';
        throw aborted;
      }
      if (ctrl.signal.aborted) {
        lastError = new Error('timeout');
        lastError.code = 'TIMEOUT';
      } else {
        lastError = err;
      }
      if (verb !== 'GET' || attempt === extra) throw lastError;
      await wait(backoff(attempt), signal);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  throw lastError;
}
