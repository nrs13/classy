/**
 * Gemini 429 bodies use the Google RPC error shape. The fields this reads are:
 * error.code, error.status, error.details[].@type,
 * RetryInfo.retryDelay ("30s" or {seconds, nanos}),
 * QuotaFailure.violations[].quotaId, quotaMetric, quotaDimensions,
 * ErrorInfo.reason and metadata.quota_metric, quota_limit, quota_limit_value.
 * error.message is never copied into a response or a log line.
 */

const DAY = /perday|per_day|daily|requestsperday/i;

export function parseRetryDelay(value) {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.ceil(value);
  if (typeof value === 'object') {
    const seconds = Number(value.seconds || 0);
    const nanos = Number(value.nanos || 0);
    if (!Number.isFinite(seconds) && !Number.isFinite(nanos)) return null;
    const total = (Number.isFinite(seconds) ? seconds : 0) + (Number.isFinite(nanos) ? nanos / 1e9 : 0);
    return total > 0 ? Math.ceil(total) : null;
  }
  const text = String(value).trim();
  const match = text.match(/^(\d+(?:\.\d+)?)s$/i);
  if (!match) return null;
  return Math.ceil(Number(match[1]));
}

function detailText(detail) {
  const bits = [
    detail?.reason,
    detail?.metadata?.quota_metric,
    detail?.metadata?.quota_limit,
    detail?.metadata?.quota_limit_value,
  ];
  for (const violation of detail?.violations || []) {
    bits.push(violation?.quotaId, violation?.quotaMetric, JSON.stringify(violation?.quotaDimensions || {}));
  }
  return bits.filter(Boolean).join(' ');
}

export function classifyGemini429(raw) {
  let parsed = null;
  try {
    parsed = JSON.parse(String(raw || ''));
  } catch {
    parsed = null;
  }
  const details = Array.isArray(parsed?.error?.details) ? parsed.error.details : [];
  let retryAfterSeconds = null;
  const texts = [];
  for (const detail of details) {
    const type = String(detail?.['@type'] || '');
    if (type.endsWith('RetryInfo')) {
      const delay = parseRetryDelay(detail.retryDelay);
      if (delay != null) retryAfterSeconds = delay;
    }
    texts.push(detailText(detail));
  }
  const haystack = texts.join(' ');
  const scope = DAY.test(haystack) ? 'day_quota' : 'minute_quota';
  if (scope === 'minute_quota' && retryAfterSeconds == null) retryAfterSeconds = 60;
  if (scope === 'day_quota') retryAfterSeconds = null;
  return { scope, retryAfterSeconds, status: 429 };
}

export function classifyProviderFailure(status, raw, kind) {
  if (kind === 'timeout') return { scope: 'timeout', retryAfterSeconds: null, status: status || 504 };
  if (kind === 'network') return { scope: 'network', retryAfterSeconds: null, status: status || 0 };
  if (status === 401 || status === 403) return { scope: 'auth', retryAfterSeconds: null, status };
  if (status === 429) return classifyGemini429(raw);
  if (status >= 500) return { scope: 'server', retryAfterSeconds: null, status };
  return { scope: 'server', retryAfterSeconds: null, status: status || 0 };
}

const FAILURE_MESSAGE = {
  minute_quota: 'Too many requests. Wait a moment and try again.',
  visitor_rate: 'Too many requests. Wait a moment and try again.',
  day_quota: 'Chat is paused in this demo.',
  own_daily_cap: 'Chat is paused in this demo.',
  auth: 'Chat is paused in this demo.',
  timeout: 'Chat is paused in this demo.',
  network: 'Chat is paused in this demo.',
  server: 'Chat is paused in this demo.',
};

export function failureBody(requestId, failure) {
  return {
    requestId,
    error: failure.scope,
    message: FAILURE_MESSAGE[failure.scope] || 'Chat is paused in this demo.',
    scope: failure.scope,
    retryAfterSeconds: failure.retryAfterSeconds ?? null,
    resetAt: failure.resetAt ?? null,
  };
}
