import { currentSnapshot } from '../repo/snapshot.js';
import { clipsForChat, secondsAt, VIDEO_ID } from '../repo/videos.js';

/** Only the open video(s) and the open second reach the model. */
export async function openKnowledge(focus) {
  if (!focus.ids.length) return { error: 'Open a video first.' };
  const snapshot = await currentSnapshot();
  if (!snapshot) return { error: 'Your Library is not available right now.' };
  const ids = focus.ids.filter((id) => VIDEO_ID.test(id));
  if (!ids.length || ids.length !== focus.ids.length) return { error: 'That video is not in your Library.' };
  const clips = await clipsForChat(snapshot.id, ids);
  if (clips.length !== ids.length) return { error: 'That video is not in your Library.' };
  const t = Math.floor(Number(focus.timeSec) || 0);
  const seconds = await secondsAt(snapshot.id, ids, t);
  const at = new Map(seconds.map((row) => [row.video_id, row]));
  return {
    snapshotId: snapshot.id,
    knowledge: {
      product: 'Classy',
      videos: clips.map((clip) => {
        const second = at.get(clip.video_id);
        const events = [];
        if (second?.speech) events.push({ type: 'speech', content: second.speech, t_sec: t });
        for (const line of second?.text_on_screen || []) {
          const text = typeof line === 'string' ? line : line?.text;
          if (text) events.push({ type: 'text_overlay', content: text, t_sec: t });
        }
        return {
          id: clip.video_id,
          account: clip.account,
          language: clip.language,
          duration: clip.duration,
          timingEligible: clip.timing_eligible,
          cuts: clip.timing_eligible ? clip.cuts || [] : [],
          metrics: {
            plays: clip.plays,
            likes: clip.likes,
            comments: clip.comments,
            followers: clip.followers,
            like_rate: clip.like_rate,
            amplification: clip.amplification,
          },
          features: {
            hook_slope: clip.hook_slope,
            peak_mean_abs: clip.peak_mean_abs,
            sustain_ratio: clip.sustain_ratio,
          },
          activation_timeline: { series: clip.curve || [] },
          story: second ? [{ t_sec: t, events }] : [],
          content_events: events,
          open_second: second || null,
        };
      }),
    },
  };
}
