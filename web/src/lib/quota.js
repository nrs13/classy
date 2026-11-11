const COOLING = new Set(['minute_quota', 'visitor_rate']);
const EXHAUSTED = new Set(['day_quota', 'own_daily_cap']);

export function quotaMessage(failure, now = Date.now(), paused = 'Chat is paused in this demo.') {
  if (!failure) return '';
  if (failure.scope === 'auth') return paused;
  if (EXHAUSTED.has(failure.scope)) {
    const when = new Date(failure.resetAt);
    if (Number.isNaN(when.getTime())) return "Chat has reached today's free limit.";
    const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(when);
    const hours = Math.max(1, Math.round((when.getTime() - now) / 3_600_000));
    const unit = hours === 1 ? 'hour' : 'hours';
    return `Chat has reached today's free limit. It comes back at ${time}, in about ${hours} ${unit}.`;
  }
  const secs = Math.max(0, Math.ceil(Number(failure.retryAfterSeconds) || 0));
  return `You can send again in ${secs} s`;
}

export function secondsLeft(until, now = Date.now()) {
  return Math.max(0, Math.ceil((until - now) / 1000));
}

/** One deadline for the whole wait. Later ticks read this instant, they do not subtract one. */
export function coolingDeadline(retryAfterSeconds, now = Date.now()) {
  return now + Math.max(0, Number(retryAfterSeconds) || 0) * 1000;
}

/** Timer and the visible-tab recheck both wait for that same deadline. */
export function onQuotaClock({ until, now, visibility = 'visible', reason = 'timer' }) {
  if (!Number.isFinite(until) || now < until) return false;
  if (reason === 'visible' && visibility !== 'visible') return false;
  return true;
}

export const LIVE_REGION = { role: 'status', 'aria-live': 'polite' };

export function quotaAnnouncement(quota, seconds, now = Date.now()) {
  if (!quota) return '';
  if (isCooling(quota.scope)) return `You can send again in ${seconds} s`;
  return quotaMessage(quota, now);
}

export function isCooling(scope) {
  return COOLING.has(scope);
}

export function startCountdown(until, onTick, now = () => Date.now()) {
  const tick = () => {
    const left = secondsLeft(until, now());
    onTick(left);
    if (left <= 0) clearInterval(id);
  };
  const id = setInterval(tick, 1000);
  tick();
  return () => clearInterval(id);
}
