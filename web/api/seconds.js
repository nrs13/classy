import { route, searchParams } from '../server/http.js';
import { AppError } from '../server/obs/errors.js';
import { currentSnapshot } from '../server/repo/snapshot.js';
import { clipDetail, secondsFor, VIDEO_ID } from '../server/repo/videos.js';

export default route('seconds', {}, async (req, res, { requestId }) => {
  const id = searchParams(req).get('id') || '';
  if (!VIDEO_ID.test(id)) throw new AppError('not_found', 404);
  const snapshot = await currentSnapshot();
  if (!snapshot) throw new AppError('no_library', 404);
  const clip = await clipDetail(snapshot.id, id);
  if (!clip) throw new AppError('not_found', 404);
  const seconds = await secondsFor(snapshot.id, id);
  res.status(200).json({
    requestId,
    videoId: id,
    snapshotId: snapshot.id,
    quoteFloor: snapshot.quoteFloor,
    timingEligible: clip.timing_eligible,
    cuts: clip.timing_eligible ? clip.cuts || [] : [],
    language: clip.language || '',
    topics: clip.topics || '',
    keywords: clip.keywords || '',
    seconds: seconds.map((second) => ({
      t_sec: second.t_sec,
      speech: second.speech || '',
      speech_score: second.speech_score,
      speaker: second.speaker || '',
      text_on_screen: second.text_on_screen || [],
      labels: second.labels || [],
      face_count: second.face_count,
      music_score: second.music_score,
      sentiment: second.sentiment,
      scenes: second.scenes || [],
      outcomes: second.outcomes || [],
      app: second.app,
      ask: second.ask,
    })),
  });
});
