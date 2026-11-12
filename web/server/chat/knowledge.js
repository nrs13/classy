import { currentSnapshot } from '../repo/snapshot.js';
import { agreedAppMarks, clipsForChat, hookSlopes, peerClips, secondsAt, VIDEO_ID } from '../repo/videos.js';
import { secondText } from '../../src/lib/secondText.js';
import { tierFor } from '../../api/catalog.js';

function nextAgreedApp(rows, timeSec) {
  const times = rows
    .map((row) => Number(row?.t_sec))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  const now = Number(timeSec) || 0;
  const next = times.find((t) => t > now + 0.04);
  return {
    on_screen_now: times.some((t) => Math.abs(t - now) <= 0.2),
    next_t_sec: next == null ? null : next,
    names_the_app: false,
  };
}

function hookPackStats(slopes, value) {
  const nums = (Array.isArray(slopes) ? slopes : []).filter((n) => Number.isFinite(n)).slice().sort((a, b) => a - b);
  const slope = Number(value);
  if (!nums.length || !Number.isFinite(slope)) return null;
  const mid = nums.length % 2 === 1
    ? nums[(nums.length - 1) / 2]
    : (nums[nums.length / 2 - 1] + nums[nums.length / 2]) / 2;
  return {
    n: nums.length,
    min: nums[0],
    median: mid,
    max: nums[nums.length - 1],
    rank: nums.filter((n) => n > slope).length + 1,
  };
}

function topicNames(raw) {
  let value = raw;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return []; }
  }
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item : item?.name))
    .filter((name) => typeof name === 'string' && name.trim())
    .slice(0, 2);
}

function appEvidence(app) {
  const value = typeof app === 'string'
    ? (() => { try { return JSON.parse(app); } catch { return null; } })()
    : app;
  const evidence = value && typeof value === 'object' ? value.evidence : '';
  return String(evidence || 'Agreed app screen');
}

/** The open clip, this second, and a few other high-play clips reach the model. */
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
  let pack = null;
  let marks = [];
  let peers = [];
  try {
    pack = await hookSlopes(snapshot.id);
  } catch {
    pack = null;
  }
  try {
    marks = await agreedAppMarks(snapshot.id, ids);
  } catch {
    marks = [];
  }
  try {
    peers = await peerClips(snapshot.id, ids, 5);
  } catch {
    peers = [];
  }
  return {
    snapshotId: snapshot.id,
    pack,
    knowledge: {
      product: 'Classy',
      pack_size: pack?.n || null,
      peers: peers.map((row) => ({
        id: row.video_id,
        account: row.account,
        plays: row.plays,
        tier: tierFor(row.plays),
        topics: topicNames(row.topics),
      })),
      videos: clips.map((clip) => {
        const second = at.get(clip.video_id);
        const events = [];
        const happens = secondText(second);
        if (happens) events.push({ type: 'happens', content: happens, t_sec: t });
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
            tier: tierFor(clip.plays),
          },
          features: {
            hook_slope: clip.hook_slope,
            peak_mean_abs: clip.peak_mean_abs,
            sustain_ratio: clip.sustain_ratio,
          },
          hook_pack: hookPackStats(pack?.slopes, clip.hook_slope),
          networks: clip.networks || null,
          activation_timeline: { series: clip.curve || [] },
          story: second ? [{ t_sec: t, events }] : [],
          content_events: events,
          open_second: second || null,
          agreed_app_screens: marks
            .filter((row) => row.video_id === clip.video_id)
            .map((row) => ({
              t_sec: Number(row.t_sec),
              evidence: appEvidence(row.app),
            })),
          next_agreed_app: nextAgreedApp(
            marks.filter((row) => row.video_id === clip.video_id),
            t,
          ),
        };
      }),
    },
  };
}
