import { AppError } from '../obs/errors.js';

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
      if (day.count >= dailyMax) throw new AppError('rate_limited', 429);
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
      if (bucket.minute >= perMinute || bucket.hour >= perHour) throw new AppError('rate_limited', 429);
      bucket.minute += 1;
      bucket.hour += 1;
      day.count += 1;
      return day.count;
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
