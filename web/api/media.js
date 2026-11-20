import { route, searchParams } from '../server/http.js';
import { signedMediaUrl, signMedia, MEDIA_TTL_MS } from '../server/media.js';
import { AppError } from '../server/obs/errors.js';
import { liveMediaObjects, VIDEO_ID } from '../server/repo/videos.js';

const KEYS = { mp4: 'mp4_object', act: 'act_object', sprite: 'sprite_object' };
const MEDIA_CACHE = `private, max-age=${Math.min(60, Math.floor(MEDIA_TTL_MS / 2000))}`;

export default route('media', { fallback: 'media_unavailable' }, async (req, res, { requestId }) => {
  const params = searchParams(req);
  const id = params.get('id') || '';
  const kind = params.get('kind') || '';
  if (!VIDEO_ID.test(id) || !KEYS[kind]) throw new AppError('bad_request', 400);
  const clip = await liveMediaObjects(id);
  const objectKey = clip?.[KEYS[kind]];
  if (!objectKey) throw new AppError('not_found', 404);
  const remote = signedMediaUrl(objectKey);
  const url = remote || `/api/object?token=${signMedia(id, kind, objectKey).token}`;
  res.setHeader('Cache-Control', MEDIA_CACHE);
  if (kind === 'sprite') {
    res.statusCode = 302;
    res.setHeader('Location', url);
    res.end();
    return;
  }
  res.status(200).json({ requestId, url, expiresAt: Date.now() + MEDIA_TTL_MS });
});
