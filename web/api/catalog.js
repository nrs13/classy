import { route } from '../server/http.js';
import { notesFor } from '../server/data/clipNotes.js';
import { currentSnapshot } from '../server/repo/snapshot.js';
import { listVideos } from '../server/repo/videos.js';

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

function clipNotes(videoId) {
  return notesFor(videoId);
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
