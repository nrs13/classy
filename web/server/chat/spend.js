import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SPEND_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.classy-spend.json');
const LIMIT_USD = 8;

const PER_TOKEN = {
  opus: { input: 5.5e-6, output: 27.5e-6, cacheRead: 0.55e-6, cacheWrite: 11e-6 },
  sonnet: { input: 3.3e-6, output: 16.5e-6, cacheRead: 0.33e-6, cacheWrite: 6.6e-6 },
  haiku: { input: 1.1e-6, output: 5.5e-6, cacheRead: 0.11e-6, cacheWrite: 2.2e-6 },
};

function ratesFor(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('haiku')) return PER_TOKEN.haiku;
  if (m.includes('sonnet')) return PER_TOKEN.sonnet;
  return PER_TOKEN.opus;
}

function isLocal() {
  return !process.env.VERCEL;
}

function readSpend() {
  try {
    const data = JSON.parse(readFileSync(SPEND_PATH, 'utf8'));
    return { usd: Number(data.usd) || 0, calls: Number(data.calls) || 0 };
  } catch {
    return { usd: 0, calls: 0 };
  }
}

export function remainingUsd() {
  if (!isLocal()) return Infinity;
  const cap = Number(process.env.CLASSY_MAX_SPEND_USD);
  const limit = Number.isFinite(cap) && cap > 0 ? cap : LIMIT_USD;
  return Math.max(0, limit - readSpend().usd);
}

export function assertUnderCap() {
  if (!isLocal()) return;
  if (remainingUsd() <= 0) {
    const err = new Error('local spend cap reached ($8)');
    err.code = 'SPEND_CAP';
    throw err;
  }
}

export function recordUsage(model, usage) {
  if (!isLocal() || !usage) return;
  const r = ratesFor(model);
  const delta =
    (Number(usage.input_tokens) || 0) * r.input +
    (Number(usage.output_tokens) || 0) * r.output +
    (Number(usage.cache_read_input_tokens) || 0) * r.cacheRead +
    (Number(usage.cache_creation_input_tokens) || 0) * r.cacheWrite;
  const prev = readSpend();
  writeFileSync(
    SPEND_PATH,
    `${JSON.stringify({
      usd: Number((prev.usd + delta).toFixed(6)),
      calls: prev.calls + 1,
      updatedAt: new Date().toISOString(),
    }, null, 2)}\n`,
  );
}
