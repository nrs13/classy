import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { route } from '../server/http.js';
import { currentSnapshot } from '../server/repo/snapshot.js';
import { listVideos } from '../server/repo/videos.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

// Same Yeo-7 atlas the mesh pack writes to web/public/data/atlas_yeo7_labels.bin.
const ATLAS = {
  name: 'Yeo-7',
  scope: 'coarse 7-network cortical parcellation',
  labels: 'atlas_yeo7_labels.bin',
  encoding: 'uint8; 0=medial wall, 1-7=network id',
  vertexCount: 20484,
  hemiSplit: 10242,
  medialWall: { label: 0, vertexCount: 1769, excludedFromNetworkMeans: true },
  networkNames: {
    1: 'Visual',
    2: 'Somatomotor',
    3: 'Dorsal Attention',
    4: 'Ventral Attention',
    5: 'Limbic',
    6: 'Frontoparietal',
    7: 'Default Mode Network',
  },
  requiresRealMesh: true,
  syntheticMeshCompatible: false,
};

export function profileUrl(videoUrl, account) {
  const raw = String(videoUrl || '').trim();
  if (!raw) return '';
  let url;
  try {
    url = new URL(raw);
  } catch {
    return '';
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host === 'tiktok.com' || host === 'm.tiktok.com') {
    const handle = url.pathname.split('/').filter(Boolean).find((part) => part.startsWith('@'));
    if (!handle || handle.length < 2) return '';
    return `https://www.tiktok.com/${handle}`;
  }
  if (host === 'instagram.com') {
    const name = String(account || '').trim().replace(/^@/, '');
    if (!name || /[/?#\s]/.test(name)) return '';
    return `https://www.instagram.com/${name}/`;
  }
  return '';
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
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch !== '\r') {
      cell += ch;
    }
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const NOTE_FIELDS = ['format', 'key_elements', 'relatability_hook'];

let notesById;
function notesTable() {
  if (notesById) return notesById;
  notesById = new Map();
  const path = join(REPO_ROOT, 'metadata.csv');
  if (!existsSync(path)) return notesById;
  const rows = parseCsv(readFileSync(path, 'utf8'));
  const header = rows.shift() || [];
  const idCol = header.indexOf('video_id');
  const cols = Object.fromEntries(NOTE_FIELDS.map((field) => [field, header.indexOf(field)]));
  if (idCol < 0) return notesById;
  for (const record of rows) {
    const id = (record[idCol] || '').trim();
    if (!id) continue;
    const notes = {};
    for (const field of NOTE_FIELDS) {
      notes[field] = cols[field] >= 0 ? (record[cols[field]] || '').trim() : '';
    }
    notesById.set(id, notes);
  }
  return notesById;
}

const metaNotesCache = new Map();
function metaNotes(videoId) {
  if (metaNotesCache.has(videoId)) return metaNotesCache.get(videoId);
  const path = join(REPO_ROOT, 'outputs', videoId, 'meta.json');
  const notes = { format: '', key_elements: '', relatability_hook: '' };
  if (existsSync(path)) {
    try {
      const body = JSON.parse(readFileSync(path, 'utf8'));
      const annotations = body?.annotations || {};
      for (const field of NOTE_FIELDS) notes[field] = String(annotations[field] || '').trim();
    } catch {
      /* keep the empty notes */
    }
  }
  metaNotesCache.set(videoId, notes);
  return notes;
}

function clipNotes(videoId) {
  const row = notesTable().get(videoId) || {};
  const meta = metaNotes(videoId);
  return {
    format: row.format || meta.format || '',
    key_elements: row.key_elements || meta.key_elements || '',
    relatability_hook: row.relatability_hook || meta.relatability_hook || '',
  };
}

export function tierFor(plays) {
  if (plays == null || plays === '') return null;
  const n = Number(plays);
  if (!Number.isFinite(n)) return null;
  if (n >= 1000000) return 'breakout';
  if (n >= 50000) return 'strong';
  if (n >= 10000) return 'mid';
  return 'tail';
}

export default route('catalog', {}, async (req, res, { requestId }) => {
  const snapshot = await currentSnapshot();
  if (!snapshot) {
    res.status(200).json({ requestId, snapshotId: null, quoteFloor: null, atlas: ATLAS, videos: [] });
    return;
  }
  const etag = `"${snapshot.id}:about"`;
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'private, no-cache');
  if (req.headers?.['if-none-match'] === etag) {
    res.status(304).end();
    return;
  }
  const rows = await listVideos(snapshot.id);
  res.status(200).json({
    requestId,
    snapshotId: snapshot.id,
    quoteFloor: snapshot.quoteFloor,
    atlas: ATLAS,
    embeddingModel: snapshot.embeddingModel,
    embeddingDim: snapshot.embeddingDim,
    videos: rows.map((row) => ({
      id: row.video_id,
      account: row.account || '',
      profileUrl: profileUrl(row.url, row.account) || undefined,
      tier: tierFor(row.plays) || undefined,
      annotations: (() => {
        const notes = clipNotes(row.video_id);
        return {
          format: notes.format || undefined,
          key_elements: notes.key_elements || undefined,
          relatability_hook: notes.relatability_hook || undefined,
        };
      })(),
      language: row.language || '',
      duration: row.duration,
      frames: row.frames,
      timingEligible: row.timing_eligible,
      cuts: row.timing_eligible ? row.cuts || [] : [],
      metrics: {
        plays: row.plays,
        likes: row.likes,
        comments: row.comments,
        followers: row.followers,
        like_rate: row.like_rate,
        amplification: row.amplification,
      },
      features: {
        hook_slope: row.hook_slope,
        peak_mean_abs: row.peak_mean_abs,
        sustain_ratio: row.sustain_ratio,
      },
      networks: row.networks || null,
      topics: row.topics || '',
      keywords: row.keywords || '',
    })),
  });
});
