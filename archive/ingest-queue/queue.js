import { route } from '../server/http.js';
import { AppError } from '../server/obs/errors.js';
import { listIngest, upsertIngest } from './ingest.js';
import { VIDEO_ID } from '../server/repo/videos.js';

/** Ingest state machine: catalog/pack_snapshot.py. The last five are older names kept for old rows. */
const STATES = new Set([
  'queued',
  'fetching',
  'tribe',
  'indexing',
  'packing',
  'validating',
  'live',
  'failed',
  'blocked',
  'downloaded',
  'tribe_ok',
  'vi_ok',
  'models_ok',
  'packed',
]);

export default route('queue', { methods: ['GET', 'POST'], fallback: 'queue_unavailable' }, async (req, res, { requestId }) => {
  if (req.method === 'GET') {
    res.status(200).json({ requestId, rows: await listIngest() });
    return;
  }
  const videoId = String(req.body?.video_id || '').trim();
  const url = String(req.body?.url || '').trim();
  if (!videoId || !url) throw new AppError('bad_request', 400, 'Add a video id and a link.');
  if (!VIDEO_ID.test(videoId)) throw new AppError('bad_request', 400, 'Video ids look like v123.');
  if (!/^https?:\/\//i.test(url) || url.length > 500) throw new AppError('bad_request', 400, 'Add a full link.');
  const state = STATES.has(req.body?.state) ? req.body.state : 'queued';
  await upsertIngest({ videoId, url, state, detail: req.body?.detail || null });
  res.status(200).json({ requestId, video_id: videoId, state });
});
