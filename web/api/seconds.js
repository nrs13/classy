import { PUBLIC_READ_CACHE, route, searchParams } from '../server/http.js';
import { AppError } from '../server/obs/errors.js';
import { liveSeconds, VIDEO_ID } from '../server/repo/videos.js';

export default route('seconds', {}, async (req, res, { requestId }) => {
  const id = searchParams(req).get('id') || '';
  if (!VIDEO_ID.test(id)) throw new AppError('not_found', 404);
  const page = await liveSeconds(id);
  if (!page) throw new AppError('not_found', 404);
  const etag = `"${page.snapshotId}:${id}:seconds"`;
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', PUBLIC_READ_CACHE);
  if (req.headers?.['if-none-match'] === etag) {
    res.status(304).end();
    return;
  }
  res.status(200).json({
    requestId,
    videoId: id,
    snapshotId: page.snapshotId,
    quoteFloor: page.quoteFloor,
    timingEligible: page.timingEligible,
    cuts: page.timingEligible ? page.cuts : [],
    language: page.language,
    topics: page.topics,
    keywords: page.keywords,
    seconds: page.seconds,
  });
});
