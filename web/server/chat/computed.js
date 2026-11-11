import { tierFor } from '../../api/catalog.js';

function commas(n) {
  return Math.round(Number(n)).toLocaleString('en-US');
}

function fixed(n) {
  return Number(n).toFixed(4);
}

function ordinal(n) {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  if (n % 10 === 1) return `${n}st`;
  if (n % 10 === 2) return `${n}nd`;
  if (n % 10 === 3) return `${n}rd`;
  return `${n}th`;
}

function finite(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x : null;
}

function packSize(pack) {
  const n = Number(pack?.n);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function hookPack(slopes, value) {
  const nums = (Array.isArray(slopes) ? slopes : []).map(finite).filter((n) => n != null).sort((a, b) => a - b);
  const slope = finite(value);
  if (!nums.length || slope == null) return null;
  const mid = nums.length % 2 === 1
    ? nums[(nums.length - 1) / 2]
    : (nums[nums.length / 2 - 1] + nums[nums.length / 2]) / 2;
  return {
    n: nums.length,
    min: nums[0],
    max: nums[nums.length - 1],
    median: mid,
    rank: nums.filter((n) => n > slope).length + 1,
  };
}

function peakOf(clip) {
  const series = clip?.activation_timeline?.series || clip?.curve || [];
  let best = null;
  for (const pt of series) {
    const abs = finite(pt?.mean_abs ?? pt?.meanAbs);
    const t = finite(pt?.t_sec ?? pt?.t);
    if (abs == null || t == null) continue;
    if (!best || abs > best.abs) best = { abs, t };
  }
  if (best) return best;
  const abs = finite(clip?.features?.peak_mean_abs ?? clip?.peak_mean_abs);
  const t = finite(clip?.features?.peak_t_sec ?? clip?.peak_t_sec);
  if (abs == null || t == null) return null;
  return { abs, t };
}

function topNetworks(clip) {
  const networks = clip?.networks;
  if (Array.isArray(networks)) {
    const rows = networks.slice(0, 3).map((row) => ({
      name: row?.name || row?.network,
      mean: finite(row?.mean ?? row?.value),
    }));
    if (rows.length < 3 || rows.some((row) => !row.name || row.mean == null)) return null;
    return rows;
  }
  const top = networks?.top || [];
  const means = networks?.means || {};
  if (top.length < 3) return null;
  const rows = top.slice(0, 3).map((name) => ({ name, mean: finite(means[name]) }));
  if (rows.some((row) => !row.name || row.mean == null)) return null;
  return rows;
}

function playsFollowers(clip) {
  const plays = finite(clip?.metrics?.plays ?? clip?.plays);
  const followers = finite(clip?.metrics?.followers ?? clip?.followers);
  const amp = finite(clip?.metrics?.amplification ?? clip?.amplification);
  if (plays == null || followers == null || followers === 0 || amp == null) return null;
  return { plays, followers, amp, tier: tierFor(plays) };
}

export function computedAnswer(question, clip, pack) {
  const q = String(question || '').trim().toLowerCase();
  const id = clip?.id || clip?.video_id;
  const n = packSize(pack) || hookPack(pack?.slopes, 0)?.n || null;
  if (!q || !id) return null;

  if (q.includes('how is amplification')) {
    const row = playsFollowers(clip);
    if (!row || !n) return null;
    return `Amplification is plays divided by followers. For ${id} that is ${commas(row.plays)} plays divided by ${commas(row.followers)} followers, which is ${commas(row.amp)}×. N=${n}.`;
  }

  if (q.includes('amplification')) {
    const row = playsFollowers(clip);
    if (!row || !row.tier || !n) return null;
    return `Amplification is plays divided by followers. ${id} has ${commas(row.plays)} plays and ${commas(row.followers)} followers, which is ${commas(row.amp)}×, so the tier is ${row.tier}. The ratio is not a cause. This pack is N=${n}.`;
  }

  if (q.includes('peak') && (q.includes('breakout') || q.includes('match'))) {
    const peak = peakOf(clip);
    const row = playsFollowers(clip);
    const about = Math.round(finite(clip?.duration) || NaN);
    if (!peak || !row || !n || !about) return null;
    return `The mean cortical activation peaks at second ${Math.round(peak.t)} of a clip about ${about} seconds long. The peak mean absolute activation is ${fixed(peak.abs)}. Breakout comes from the public play count, ${commas(row.plays)}, not from the peak time. The peak time does not explain the tier. N=${n}.`;
  }

  if (q.includes('peak')) {
    const peak = peakOf(clip);
    const about = Math.round(finite(clip?.duration) || NaN);
    if (!peak || !about) return null;
    return `The peak mean absolute cortical activation is ${fixed(peak.abs)}, at second ${Math.round(peak.t)} of a clip about ${about} seconds long.`;
  }

  if (q.includes('rank') || q.includes('network')) {
    const rows = topNetworks(clip);
    if (!rows || !n) return null;
    return `${rows[0].name} is rank 1 at ${fixed(rows[0].mean)}. Rank 2 is ${rows[1].name} at ${fixed(rows[1].mean)} and rank 3 is ${rows[2].name} at ${fixed(rows[2].mean)}. Those are the next two predicted Yeo-7 means. They do not replace ${rows[0].name}, and a mean is not a cause. N=${n}.`;
  }

  if (q.includes('caveat')) {
    if (!n) return null;
    return `The pack is ${n} videos. Amplification is plays divided by followers. The activation is a predicted encoding, not a measured brain. A network mean or a peak time does not show that a line, a face, or a cut caused the plays.`;
  }

  if (q.includes('sustain')) {
    const sustain = finite(clip?.features?.sustain_ratio ?? clip?.sustain_ratio);
    if (sustain == null || !n) return null;
    if (sustain === 1) {
      return 'sustain_ratio is the share of post-hook frames at or above half the peak. A value of 1 means every post-hook frame in this timeline stayed at or above half the peak. It does not say the plays were caused by that shape. N=' + n + '.';
    }
    return `sustain_ratio is the share of post-hook frames at or above half the peak. A value of ${fixed(sustain)} is that share for this timeline. It does not say the plays were caused by that shape. N=${n}.`;
  }

  if (q.includes('hook')) {
    const slope = finite(clip?.features?.hook_slope ?? clip?.hook_slope);
    const stats = hookPack(pack?.slopes, slope);
    const row = playsFollowers(clip);
    if (slope == null || !stats || !row) return null;
    return `${id}'s hook slope is ${fixed(slope)}. Across the ${stats.n} clips the lowest is ${fixed(stats.min)}, the median is ${fixed(stats.median)}, and the highest is ${fixed(stats.max)}. ${fixed(slope)} is ${ordinal(stats.rank)} highest. The breakout tier still comes from ${commas(row.plays)} plays, not from the hook slope.`;
  }

  return null;
}

export function questionsFor(clip, pack) {
  const id = clip?.id || clip?.video_id;
  if (!id) return [];
  const prompts = [
    playsFollowers(clip) ? `How did ${id} reach ${commas(playsFollowers(clip).amp)}× amplification from ${commas(playsFollowers(clip).followers)} followers?` : null,
    peakOf(clip) ? `What's ${id}'s peak mean cortical activation, and when does it occur?` : null,
    topNetworks(clip) ? `What do ${id}'s top networks add beyond the baseline?` : null,
    packSize(pack) ? 'What are the biggest caveats of this analysis at N=' + packSize(pack) + '?' : null,
    finite(clip?.features?.sustain_ratio ?? clip?.sustain_ratio) != null ? `What does ${id}'s sustain_ratio of ${finite(clip?.features?.sustain_ratio ?? clip?.sustain_ratio)} say about its activation timeline?` : null,
    finite(clip?.features?.hook_slope ?? clip?.hook_slope) != null ? `How does ${id}'s hook slope (${fixed(clip?.features?.hook_slope ?? clip?.hook_slope)}) compare across this pack?` : null,
  ];
  return prompts.filter(Boolean);
}
