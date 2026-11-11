import { AppError } from '../obs/errors.js';
import { nextPacificMidnight } from './resetAt.js';

export const VISITOR_PER_MINUTE = 4;
export const VISITOR_PER_HOUR = 20;
export const DAILY_REQUEST_CAP = 400;
export const CHAT_TIMEOUT_MS = 25_000;
export const MAX_OUTPUT_TOKENS = 800;

export function pacificDay(now) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date(now));
}

export function clientIp(req) {
  const forwarded = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req?.socket?.remoteAddress || 'local';
}

export function createChatGuard({
  now = () => Date.now(),
  dailyMax = DAILY_REQUEST_CAP,
  perMinute = VISITOR_PER_MINUTE,
  perHour = VISITOR_PER_HOUR,
} = {}) {
  const visitors = new Map();
  let day = { key: pacificDay(now()), count: 0 };
  return {
    take(ip) {
      const t = now();
      const key = pacificDay(t);
      if (key !== day.key) day = { key, count: 0 };
      if (day.count >= dailyMax) {
        const err = new AppError('own_daily_cap', 429);
        err.scope = 'own_daily_cap';
        err.resetAt = nextPacificMidnight(t);
        throw err;
      }
      const id = ip || 'local';
      let bucket = visitors.get(id);
      if (!bucket) {
        bucket = { minuteStart: t, minute: 0, hourStart: t, hour: 0 };
        visitors.set(id, bucket);
      }
      if (t - bucket.minuteStart >= 60_000) {
        bucket.minuteStart = t;
        bucket.minute = 0;
      }
      if (t - bucket.hourStart >= 3_600_000) {
        bucket.hourStart = t;
        bucket.hour = 0;
      }
      if (bucket.minute >= perMinute || bucket.hour >= perHour) {
        const err = new AppError('visitor_rate', 429);
        const minuteHit = bucket.minute >= perMinute;
        const windowMs = minuteHit ? 60_000 : 3_600_000;
        const start = minuteHit ? bucket.minuteStart : bucket.hourStart;
        err.scope = 'visitor_rate';
        err.retryAfterSeconds = Math.max(1, Math.ceil((windowMs - (t - start)) / 1000));
        throw err;
      }
      bucket.minute += 1;
      bucket.hour += 1;
      day.count += 1;
      return day.count;
    },
    inspect(ip) {
      const t = now();
      const key = pacificDay(t);
      if (key !== day.key) day = { key, count: 0 };
      if (day.count >= dailyMax) {
        return { state: 'exhausted', resetAt: nextPacificMidnight(t), retryAfterSeconds: null };
      }
      const bucket = visitors.get(ip || 'local');
      if (bucket && t - bucket.minuteStart < 60_000 && bucket.minute >= perMinute) {
        return {
          state: 'cooling',
          resetAt: null,
          retryAfterSeconds: Math.max(1, Math.ceil((60_000 - (t - bucket.minuteStart)) / 1000)),
        };
      }
      if (bucket && t - bucket.hourStart < 3_600_000 && bucket.hour >= perHour) {
        return {
          state: 'cooling',
          resetAt: null,
          retryAfterSeconds: Math.max(1, Math.ceil((3_600_000 - (t - bucket.hourStart)) / 1000)),
        };
      }
      return { state: 'ok', resetAt: null, retryAfterSeconds: null };
    },
  };
}

const guards = new Map();

export function chatGuardFor(env = process.env) {
  const dailyMax = Number(env.CLASSY_CHAT_DAILY_CAP);
  const key = Number.isFinite(dailyMax) && dailyMax > 0 ? String(dailyMax) : 'default';
  if (!guards.has(key)) {
    guards.set(
      key,
      createChatGuard({
        dailyMax: key === 'default' ? DAILY_REQUEST_CAP : dailyMax,
      }),
    );
  }
  return guards.get(key);
}

export function resetChatGuards() {
  guards.clear();
}
