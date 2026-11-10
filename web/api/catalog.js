import { route } from '../server/http.js';
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

export default route('catalog', {}, async (req, res, { requestId }) => {
  const snapshot = await currentSnapshot();
  if (!snapshot) {
    res.status(200).json({ requestId, snapshotId: null, quoteFloor: null, atlas: ATLAS, videos: [] });
    return;
  }
  const etag = `"${snapshot.id}:yeo7"`;
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
