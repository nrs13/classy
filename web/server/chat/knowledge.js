import { currentSnapshot } from '../repo/snapshot.js';
import { agreedAppMarks, clipsForChat, hookSlopes, peerClips, secondsAt, secondsFor, VIDEO_ID } from '../repo/videos.js';
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

function askedVideoIds(message, openIds) {
  const open = new Set(openIds);
  const found = String(message || '').match(/\bv\d+\b/g) || [];
  return [...new Set(found)].filter((id) => VIDEO_ID.test(id) && !open.has(id)).slice(0, 2);
}

function askedSecondSet(message) {
  const set = new Set();
  const re = /\b(?:second|sec)\s+(\d{1,4})\b|\bat\s+(\d{1,4})\s*(?:s|sec|seconds?)\b/gi;
  for (const match of String(message || '').matchAll(re)) {
    const n = Number(match[1] || match[2]);
    if (Number.isFinite(n)) set.add(n);
  }
  return set;
}

function firstAskedSecond(message) {
  const set = askedSecondSet(message);
  return set.size ? [...set][0] : 0;
}

function peakFromCurve(curve) {
  let best = null;
  for (const point of Array.isArray(curve) ? curve : []) {
    const abs = Number(point?.mean_abs ?? point?.meanAbs);
    const t = Number(point?.t_sec ?? point?.t);
    if (!Number.isFinite(abs) || !Number.isFinite(t)) continue;
    if (!best || abs > best.abs) best = { abs, t };
  }
  return best;
}

function timelineLines(rows, asked) {
  return (Array.isArray(rows) ? rows : []).slice(0, 90).map((row) => {
    const t = Number(row?.t_sec);
    const happens = secondText(row).replace(/\s+/g, ' ').trim();
    const speech = String(row?.speech || '').replace(/\s+/g, ' ').trim();
    let line = (happens || speech).slice(0, 140);
    if (asked.has(t) && speech) line = `${line} Said: ${speech.slice(0, 180)}`.trim().slice(0, 320);
    return { t_sec: t, line };
  }).filter((row) => Number.isFinite(row.t_sec) && row.line);
}

function appEvidence(app) {
  const value = typeof app === 'string'
    ? (() => { try { return JSON.parse(app); } catch { return null; } })()
    : app;
  const evidence = value && typeof value === 'object' ? value.evidence : '';
  return String(evidence || 'Agreed app screen');
}

/** The open clip, this second, and a few other high-play clips reach the model. */
export async function openKnowledge(focus, message = '') {
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
  let timelineRows = [];
  let asked = [];
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
  try {
    timelineRows = await secondsFor(snapshot.id, ids[0]);
  } catch {
    timelineRows = [];
  }
  const extraIds = askedVideoIds(message, ids);
  if (extraIds.length) {
    try {
      const extra = await clipsForChat(snapshot.id, extraIds);
      const sec = firstAskedSecond(message);
      const rows = await secondsAt(snapshot.id, extraIds, sec);
      const atExtra = new Map(rows.map((row) => [row.video_id, row]));
      asked = extra.map((clip) => ({
        id: clip.video_id,
        account: clip.account,
        plays: clip.plays,
        tier: tierFor(clip.plays),
        t_sec: sec,
        line: secondText(atExtra.get(clip.video_id)) || '',
      }));
    } catch {
      asked = [];
    }
  }
  const askedSeconds = askedSecondSet(message);
  const timeline = timelineLines(timelineRows, askedSeconds);
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
      asked,
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
            peak_mean_abs: peakFromCurve(clip.curve)?.abs ?? clip.peak_mean_abs,
            peak_t_sec: peakFromCurve(clip.curve)?.t ?? null,
            sustain_ratio: clip.sustain_ratio,
          },
          hook_pack: hookPackStats(pack?.slopes, clip.hook_slope),
          networks: clip.networks || null,
          timeline: clip.video_id === ids[0] ? timeline : [],
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
