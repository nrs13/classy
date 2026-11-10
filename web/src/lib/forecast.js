/** Display copy for the held-out cut result. Ranges are the shared overlaps, not a refit. */

export const WITHIN_CLIP =
  'This is a within-video change in the stored predicted curve.';

export const VISUAL_LAG_1 =
  'On accounts the fit did not use, a cut goes with a higher absolute predicted visual curve one second later, shared range 0.01625 to 0.02857.';

export const VISUAL_LAG_2 =
  'On accounts the fit did not use, a cut goes with a higher absolute predicted visual curve two seconds later, shared range 0.01543 to 0.02672.';

export const DORSAL_LAG_2 =
  'On accounts the fit did not use, a cut goes with a higher absolute predicted dorsal-attention curve two seconds later, shared range 0.008955 to 0.01658.';

export function timingSource(video, packed) {
  if (video?.timingEligible && Array.isArray(video.cuts) && video.cuts.length) {
    return { timingEligible: true, cuts: video.cuts.map(Number).filter(Number.isFinite) };
  }
  if (packed?.timingEligible && Array.isArray(packed.cuts) && packed.cuts.length) {
    return { timingEligible: true, cuts: packed.cuts.map(Number).filter(Number.isFinite) };
  }
  return null;
}

export function cutMarks(cuts, duration) {
  const dur = Number(duration) || 0;
  if (!dur || !Array.isArray(cuts)) return [];
  const seen = new Set();
  const marks = [];
  for (const raw of cuts) {
    const cut = Number(raw);
    if (!Number.isFinite(cut)) continue;
    for (const [offset, kind] of [
      [0, 'cut'],
      [1, 'lag1'],
      [2, 'lag2'],
    ]) {
      const t = cut + offset;
      if (t < 0 || t > dur + 0.05) continue;
      const key = `${Math.round(t * 1000)}:${kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      marks.push({
        t,
        kind,
        left: Math.max(0, Math.min(100, (t / dur) * 100)),
      });
    }
  }
  return marks;
}

export function sentencesAt(source, timeSec) {
  if (!source?.timingEligible || !Array.isArray(source.cuts) || !source.cuts.length) return [];
  const t = Math.floor(Number(timeSec) || 0);
  const cuts = source.cuts.map(Number);
  const lines = [];
  if (cuts.some((c) => c + 1 === t)) lines.push(VISUAL_LAG_1);
  if (cuts.some((c) => c + 2 === t)) {
    lines.push(VISUAL_LAG_2);
    lines.push(DORSAL_LAG_2);
  }
  if (lines.length) lines.push(WITHIN_CLIP);
  return lines;
}
