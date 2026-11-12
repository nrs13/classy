import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { productionDatabaseBlocked } from '../web/server/repo/productionGuard.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(new URL('../web/package.json', import.meta.url));
const pg = require('pg');

const NOTE_FIELDS = ['format', 'key_elements', 'relatability_hook'];

function blank() {
  return { format: '', key_elements: '', relatability_hook: '' };
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch !== '\r') cell += ch;
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function fromCsv(path, into) {
  if (!existsSync(path)) return;
  const rows = parseCsv(readFileSync(path, 'utf8'));
  const header = rows.shift() || [];
  const idCol = header.indexOf('video_id');
  if (idCol < 0) return;
  const cols = Object.fromEntries(NOTE_FIELDS.map((field) => [field, header.indexOf(field)]));
  for (const record of rows) {
    const id = (record[idCol] || '').trim();
    if (!id || !into[id]) continue;
    for (const field of NOTE_FIELDS) {
      const value = cols[field] >= 0 ? (record[cols[field]] || '').trim() : '';
      if (value) into[id][field] = value;
    }
  }
}

function fromOutputs(dir, into) {
  if (!existsSync(dir)) return;
  for (const id of Object.keys(into)) {
    const path = join(dir, id, 'meta.json');
    if (!existsSync(path)) continue;
    try {
      const body = JSON.parse(readFileSync(path, 'utf8'));
      const annotations = body?.annotations || {};
      for (const field of NOTE_FIELDS) {
        const value = String(annotations[field] || '').trim();
        if (value && !into[id][field]) into[id][field] = value;
      }
    } catch {
      /* leave the empty notes */
    }
  }
}

if (productionDatabaseBlocked()) {
  console.error('Refusing the production database.');
  process.exit(1);
}

const connectionString = process.env.DATABASE_URL || 'postgresql:///classy';
const pool = new pg.Pool({ connectionString, max: 1, statement_timeout: 8000 });
const result = await pool.query(`
  SELECT c.video_id
  FROM clip c
  JOIN pointer p ON p.id = 1 AND p.snapshot_id = c.snapshot_id
  ORDER BY c.video_id
`);
await pool.end();

const notes = {};
for (const row of result.rows) notes[row.video_id] = blank();
fromCsv(join(root, 'metadata.csv'), notes);
fromOutputs(join(root, 'outputs'), notes);

const out = join(root, 'web/server/data/notes.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(notes, null, 2)}\n`);
console.log(JSON.stringify({ entries: Object.keys(notes).length }));
