#!/usr/bin/env node
/**
 * Explains one search: every lane with rank, score and text, then the fused groups.
 *   node scripts/search-debug.mjs "how was the math exam" [--lang ja] [--kind said] [--expect v027]
 *   [--snapshot ID] [--mode exact] [--lanes 10]
 * Local only; reads web/.env.local and the database directly.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
for (const line of (() => {
  try {
    return readFileSync(join(here, '..', '.env.local'), 'utf8').split('\n');
  } catch {
    return [];
  }
})()) {
  const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
}
process.env.CLASSY_LOG = 'off';
const { assertDevDatabase } = await import('../server/repo/productionGuard.js');
assertDevDatabase();

const args = process.argv.slice(2);
const flag = (name, fallback = '') => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const q = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
if (!q) {
  console.error('usage: search-debug.mjs "query" [--lang xx] [--kind said|on_screen|scene] [--expect vNNN]');
  process.exit(2);
}
const expect = flag('expect');
const laneRows = Number(flag('lanes', '10'));

const { searchLibrary } = await import('../server/search/service.js');
const { closePool } = await import('../server/repo/pool.js');

const cut = (text, n = 90) => String(text || '').replace(/\s+/g, ' ').slice(0, n);
const mark = (videoId) => (expect && videoId === expect ? ' <==' : '');

try {
  const body = await searchLibrary({
    q,
    lang: flag('lang'),
    field: flag('kind'),
    limit: 10,
    mode: flag('mode') === 'exact' ? 'exact' : 'auto',
    snapshotId: flag('snapshot') || undefined,
    trace: true,
  });
  console.log(`query: ${q}`);
  console.log(`snapshot ${body.snapshotId}  mode ${body.mode}  notice ${body.notice ?? '-'}`);
  if (body.understood) console.log(`understood: ${JSON.stringify(body.understood)}`);
  console.log(`timing ${JSON.stringify(body.timing)}`);
  for (const [lane, hits] of Object.entries(body.trace.lanes)) {
    console.log(`\n-- lane ${lane} (${hits.length} shown)`);
    hits.slice(0, laneRows).forEach((h, i) => {
      const score = h.score == null ? '' : Number(h.score).toFixed(3);
      console.log(`${String(i + 1).padStart(3)} ${h.videoId.padEnd(5)} ${String(h.tSec).padStart(4)}s ${h.field.padEnd(14)} ${score.padStart(6)} ${h.exact ? 'X' : ' '} ${cut(h.text)}${mark(h.videoId)}`);
    });
    if (expect) {
      const at = hits.findIndex((h) => h.videoId === expect);
      console.log(`   ${expect}: ${at >= 0 ? `first at rank ${at + 1}` : 'not in this lane'}`);
    }
  }
  console.log('\n-- fused groups');
  body.trace.groups.forEach((g, i) => {
    console.log(`${String(i + 1).padStart(3)} ${g.videoId.padEnd(5)} score ${g.score.toFixed(5)} ${g.exact ? 'exact' : ''}${mark(g.videoId)}`);
    for (const m of g.moments) {
      const lanes = Object.entries(m.lanes || {})
        .map(([name, v]) => `${name}#${v.rank}${v.videoRank ? `/v${v.videoRank}` : ''}`)
        .join(' ');
      console.log(`      ${String(m.tSec).padStart(4)}s ${m.field.padEnd(14)} ${lanes.padEnd(28)} ${cut(m.text, 70)}`);
    }
  });
  if (expect) {
    const at = body.trace.groups.findIndex((g) => g.videoId === expect);
    console.log(`\n${expect}: ${at >= 0 ? `result ${at + 1}` : 'not in the top 10'}`);
  }
} finally {
  await closePool();
}
