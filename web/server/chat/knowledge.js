import { notesFor } from '../data/clipNotes.js';
import { currentSnapshot } from '../repo/snapshot.js';
import { agreedAppMarks, clipsForChat, hookSlopes, peerClips, secondsAt, secondsFor, VIDEO_ID } from '../repo/videos.js';
import { tierFor } from '../../api/catalog.js';

const MEMORY_MS = 15000;
let snapshotCache = { at: 0, value: null };
const slopeCache = new Map();

export function clearKnowledgeCache() {
  snapshotCache = { at: 0, value: null };
  slopeCache.clear();
}

async function snapshotOnce() {
  const now = Date.now();
  if (snapshotCache.value && now - snapshotCache.at < MEMORY_MS) return snapshotCache.value;
  const value = await currentSnapshot();
  if (value) snapshotCache = { at: now, value };
  return value;
}

async function slopesOnce(snapshotId) {
  const now = Date.now();
  const hit = slopeCache.get(snapshotId);
  if (hit && now - hit.at < MEMORY_MS) return hit.value;
  try {
    const value = await hookSlopes(snapshotId);
    slopeCache.set(snapshotId, { at: now, value });
    return value;
  } catch {
    return null;
  }
}

export function windowTimeline(rows, playhead, askedSeconds) {
  const t = Math.floor(Number(playhead) || 0);
  const wanted = new Set([t - 2, t - 1, t, t + 1, t + 2].filter((n) => n >= 0));
  if (askedSeconds && typeof askedSeconds.forEach === 'function') {
    askedSeconds.forEach((sec) => {
      const n = Number(sec);
      if (Number.isFinite(n) && n >= 0) wanted.add(Math.floor(n));
    });
  }
  const list = Array.isArray(rows) ? rows : [];
  return list.filter((row) => wanted.has(Number(row?.t_sec)));
}

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

function screenText(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .map((item) => (typeof item === 'string' ? item : item?.text || ''))
    .filter(Boolean)
    .join(' / ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function timelineLines(rows, cap = 220) {
  const limit = cap === 140 ? 140 : 220;
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const t = Number(row?.t_sec);
    const happens = String(row?.happens || '').replace(/\s+/g, ' ').trim();
    const speech = String(row?.speech || '').replace(/\s+/g, ' ').trim();
    const screen = screenText(row?.text_on_screen);
    const speaker = String(row?.speaker || '').replace(/\s+/g, ' ').trim();
    const bits = [];
    if (happens) bits.push(happens);
    if (speech) bits.push(`Said: ${speech}`);
    if (screen) bits.push(`On screen: ${screen}`);
    if (speaker) bits.push(`Speaker: ${speaker}`);
    return { t_sec: t, line: bits.join(' ').slice(0, limit) };
  }).filter((row) => Number.isFinite(row.t_sec) && row.line);
}

function appEvidence(app) {
  const value = typeof app === 'string'
    ? (() => { try { return JSON.parse(app); } catch { return null; } })()
    : app;
  const evidence = value && typeof value === 'object' ? value.evidence : '';
  return String(evidence || 'Agreed app screen');
}

/** The open clip, a short window around the playhead, and a few other high-play clips reach the model. */
export async function openKnowledge(focus, message = '') {
  if (!focus.ids.length) return { error: 'Open a video first.' };
  const snapshot = await snapshotOnce();
  if (!snapshot) return { error: 'Your Library is not available right now.' };
  const ids = focus.ids.filter((id) => VIDEO_ID.test(id));
  if (!ids.length || ids.length !== focus.ids.length) return { error: 'That video is not in your Library.' };
  const t = Math.floor(Number(focus.timeSec) || 0);
  const extraIds = askedVideoIds(message, ids);
  const askedSeconds = askedSecondSet(message);
  const sec = firstAskedSecond(message);
  const [clips, seconds, pack, marks, peers, timelineRows, extra, extraRows] = await Promise.all([
    clipsForChat(snapshot.id, ids),
    secondsAt(snapshot.id, ids, t),
    slopesOnce(snapshot.id),
    agreedAppMarks(snapshot.id, ids).catch(() => []),
    peerClips(snapshot.id, ids, 5).catch(() => []),
    secondsFor(snapshot.id, ids[0]).catch(() => []),
    extraIds.length ? clipsForChat(snapshot.id, extraIds).catch(() => []) : Promise.resolve([]),
    extraIds.length ? secondsAt(snapshot.id, extraIds, sec).catch(() => []) : Promise.resolve([]),
  ]);
  if (clips.length !== ids.length) return { error: 'That video is not in your Library.' };
  const at = new Map(seconds.map((row) => [row.video_id, row]));
  const atExtra = new Map((extraRows || []).map((row) => [row.video_id, row]));
  const asked = (extra || []).map((clip) => ({
    id: clip.video_id,
    account: clip.account,
    plays: clip.plays,
    tier: tierFor(clip.plays),
    t_sec: sec,
    line: String(atExtra.get(clip.video_id)?.speech || atExtra.get(clip.video_id)?.happens || '').replace(/\s+/g, ' ').trim(),
  }));
  const timeline = timelineLines(timelineRows, 220);
  const windowed = timelineLines(windowTimeline(timelineRows, t, askedSeconds), 220);
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
        const happens = String(second?.happens || '').replace(/\s+/g, ' ').trim();
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
          topics: clip.topics,
          keywords: clip.keywords,
          notes: notesFor(clip.video_id),
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
          window: clip.video_id === ids[0] ? windowed : [],
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
