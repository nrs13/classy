import { route, searchParams } from '../server/http.js';
import { signedGcsUrl, signMedia, MEDIA_TTL_MS } from '../server/media.js';
import { AppError } from '../server/obs/errors.js';
import { currentSnapshot } from '../server/repo/snapshot.js';
import { mediaObjects, VIDEO_ID } from '../server/repo/videos.js';

const KEYS = { mp4: 'mp4_object', act: 'act_object', sprite: 'sprite_object' };

export default route('media', { fallback: 'media_unavailable' }, async (req, res, { requestId }) => {
  const params = searchParams(req);
  const id = params.get('id') || '';
  const kind = params.get('kind') || '';
  if (!VIDEO_ID.test(id) || !KEYS[kind]) throw new AppError('bad_request', 400);
  const snapshot = await currentSnapshot();
  if (!snapshot) throw new AppError('no_library', 404);
  const clip = await mediaObjects(snapshot.id, id);
  const objectKey = clip?.[KEYS[kind]];
  if (!objectKey) throw new AppError('not_found', 404);
  const gcs = await signedGcsUrl(objectKey).catch(() => null);
  const url = gcs || `/api/object?token=${signMedia(id, kind, objectKey).token}`;
  if (kind === 'sprite') {
    // Used directly as an <img> source; the redirect may be reused while the signature is valid.
    res.setHeader('Cache-Control', `private, max-age=${Math.floor(MEDIA_TTL_MS / 2000)}`);
    res.statusCode = 302;
    res.setHeader('Location', url);
    res.end();
    return;
  }
  res.setHeader('Cache-Control', 'private, no-store');
  res.status(200).json({ requestId, url, expiresAt: Date.now() + MEDIA_TTL_MS });
});
