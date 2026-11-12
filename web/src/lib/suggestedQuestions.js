import { amplificationLabel } from './figures.js';

function fmtNum(n) {
  if (n == null || Number.isNaN(Number(n))) return 'n/a';
  const x = Number(n);
  if (Math.abs(x) >= 1000) return Math.round(x).toLocaleString('en-US');
  if (Math.abs(x - Math.round(x)) < 1e-9 && Math.abs(x) >= 1) {
    return String(Math.round(x));
  }
  if (Math.abs(x) >= 10) return x.toFixed(1);
  if (Math.abs(x) >= 1) return x.toFixed(2);
  return x.toFixed(4);
}

function fmtAmp(n) {
  return amplificationLabel(n) || 'n/a';
}

function peakTiming(video) {
  const series = video?.activation_timeline?.series;
  if (!Array.isArray(series) || series.length === 0) {
    return { tPeak: null, peakAbs: null };
  }
  let peak = series[0];
  for (const pt of series) {
    if ((pt.mean_abs ?? 0) > (peak.mean_abs ?? 0)) peak = pt;
  }
  return {
    tPeak: Number(peak.t_sec ?? 0),
    peakAbs: Number(peak.mean_abs ?? 0),
  };
}

function networkGap(video) {
  const top = video?.networks?.top || [];
  const means = video?.networks?.means || {};
  const n1 = top[0] || null;
  const n2 = top[1] || null;
  const n3 = top[2] || null;
  const m1 = n1 != null ? Number(means[n1]) : null;
  const m2 = n2 != null ? Number(means[n2]) : null;
  const m3 = n3 != null ? Number(means[n3]) : null;
  const gap12 = m1 != null && m2 != null ? m1 - m2 : null;
  const gap23 = m2 != null && m3 != null ? m2 - m3 : null;
  return { n1, n2, n3, m1, m2, m3, gap12, gap23 };
}

function packStats(videos) {
  const gaps = [];
  let minPlays = Infinity;
  let maxPlays = -Infinity;
  let minPlaysId = null;
  for (const v of videos) {
    const { gap12 } = networkGap(v);
    if (gap12 != null) gaps.push(gap12);
    const plays = Number(v?.metrics?.plays);
    if (Number.isFinite(plays)) {
      if (plays < minPlays) {
        minPlays = plays;
        minPlaysId = v.id;
      }
      if (plays > maxPlays) maxPlays = plays;
    }
  }
  gaps.sort((a, b) => a - b);
  const medianGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0.05;
  return { n: videos.length, medianGap, minPlaysId, minPlays, maxPlays };
}

function byIdMap(knowledge) {
  const map = new Map();
  for (const v of knowledge?.videos || []) map.set(v.id, v);
  return map;
}

function videoCandidates(video, pack) {
  if (!video) return [];
  const id = video.id;
  const tier = video.tier || 'unknown';
  const hook = Number(video.features?.hook_slope);
  const amp = Number(video.metrics?.amplification);
  const plays = Number(video.metrics?.plays);
  const followers = Number(video.metrics?.followers);
  const sustain = Number(video.features?.sustain_ratio);
  const dur =
    Number(video.duration) ||
    Number(video.features?.duration_sec) ||
    0;
  const { tPeak, peakAbs } = peakTiming(video);
  const { n2, n3, m1, m2, gap12 } = networkGap(video);
  const out = [];

  if (Number.isFinite(hook) && hook < 0 && (tier === 'strong' || tier === 'breakout')) {
    out.push({
      id: `hook-neg-${id}`,
      score: 95,
      text: `Why can ${id}'s negative hook slope (${fmtNum(hook)}) still land in the ${tier} tier?`,
    });
  } else if (Number.isFinite(hook) && hook > 0.01 && (tier === 'tail' || tier === 'mid')) {
    out.push({
      id: `hook-pos-weak-${id}`,
      score: 78,
      text: `${id} has a solid hook slope (${fmtNum(hook)}) but only ${fmtNum(plays)} plays. What else explains the ${tier} tier?`,
    });
  }

  if (tier === 'breakout') {
    out.push({
      id: `tier-breakout-${id}`,
      score: 92,
      text: `How did ${id} reach ${fmtAmp(amp)} amplification from ${fmtNum(followers)} followers?`,
    });
  } else if (pack.minPlaysId === id || (tier === 'tail' && plays === pack.minPlays)) {
    out.push({
      id: `tier-bottom-${id}`,
      score: 88,
      text: `Why is ${id} at the bottom of this pack with ${fmtNum(plays)} plays and ${fmtAmp(amp)} amplification?`,
    });
  } else if (tier === 'tail') {
    out.push({
      id: `tier-tail-${id}`,
      score: 72,
      text: `What keeps ${id} in the tail tier at ${fmtNum(plays)} plays despite its brain features?`,
    });
  } else if (tier === 'strong') {
    out.push({
      id: `tier-strong-${id}`,
      score: 70,
      text: `What separates ${id}'s ${fmtAmp(amp)} amplification from the breakout in this pack?`,
    });
  }

  if (gap12 != null && m1 != null && m2 != null && n2) {
    if (gap12 >= pack.medianGap * 1.15) {
      out.push({
        id: `net-wide-${id}`,
        score: 74,
        text: `${id}'s Visual lead over ${n2} is wide (${fmtNum(m1)} vs ${fmtNum(m2)}). What do ranks 2 and 3 add beyond the baseline?`,
      });
    } else if (gap12 <= pack.medianGap * 0.55) {
      out.push({
        id: `net-tight-${id}`,
        score: 76,
        text: `${id}'s top networks are tightly clustered (Visual ${fmtNum(m1)}, ${n2} ${fmtNum(m2)}). Is that distinctive here?`,
      });
    } else if (n2 && n3) {
      out.push({
        id: `net-rank23-${id}`,
        score: 58,
        text: `For ${id}, why do ${n2} and ${n3} land in ranks 2 and 3 after Visual?`,
      });
    }
  }

  if (tPeak != null && dur > 0) {
    const frac = tPeak / dur;
    if (frac <= 0.28) {
      out.push({
        id: `peak-early-${id}`,
        score: 82,
        text: `${id}'s mean cortical activation peaks early at second ${Math.round(tPeak)} of ~${Math.round(dur)}. What happens after?`,
      });
    } else if (frac >= 0.72) {
      out.push({
        id: `peak-late-${id}`,
        score: 84,
        text: `${id}'s mean cortical activation peaks late at second ${Math.round(tPeak)} of ~${Math.round(dur)}. Does that match its ${tier} outcome?`,
      });
    } else {
      out.push({
        id: `peak-mid-${id}`,
        score: 55,
        text: `What's happening around ${id}'s peak at second ${Math.round(tPeak)} (mean cortical activation ${fmtNum(peakAbs)})?`,
      });
    }
  }

  out.push({
    id: `fallback-amp-${id}`,
    score: 40,
    text: `How is amplification computed for ${id}? Show the numbers (${fmtNum(plays)} plays / ${fmtNum(followers)} followers).`,
  });
  out.push({
    id: `fallback-peak-${id}`,
    score: 38,
    text: `What's ${id}'s peak mean cortical activation, and when does it occur?`,
  });
  if (Number.isFinite(sustain)) {
    out.push({
      id: `fallback-sustain-${id}`,
      score: 36,
      text: `What does ${id}'s sustain_ratio of ${fmtNum(sustain)} say about its activation timeline?`,
    });
  }
  if (Number.isFinite(hook)) {
    out.push({
      id: `fallback-hook-${id}`,
      score: 34,
      text: `How does ${id}'s hook slope (${fmtNum(hook)}) compare across this N=${pack.n} pack?`,
    });
  }

  return out;
}

function compareCandidates(videos) {
  if (!videos || videos.length < 2) return [];
  const [a, b] = videos;
  const out = [];
  const ampA = Number(a.metrics?.amplification);
  const ampB = Number(b.metrics?.amplification);
  if (Number.isFinite(ampA) && Number.isFinite(ampB)) {
    out.push({
      id: `cmp-amp-${a.id}-${b.id}`,
      score: 90,
      text: `Compare amplification for ${a.id} (${fmtAmp(ampA)}) vs ${b.id} (${fmtAmp(ampB)}) in plain words.`,
    });
  }
  const netA = networkGap(a);
  const netB = networkGap(b);
  if (netA.n2 && netB.n2) {
    out.push({
      id: `cmp-net-${a.id}-${b.id}`,
      score: 86,
      text: `How do rank-2 networks differ for ${a.id} (${netA.n2}) vs ${b.id} (${netB.n2})?`,
    });
  }
  const hookA = Number(a.features?.hook_slope);
  const hookB = Number(b.features?.hook_slope);
  if (Number.isFinite(hookA) && Number.isFinite(hookB)) {
    out.push({
      id: `cmp-hook-${a.id}-${b.id}`,
      score: 80,
      text: `Whose hook slope is stronger, ${a.id} (${fmtNum(hookA)}) or ${b.id} (${fmtNum(hookB)}), and did plays follow?`,
    });
  }
  if (videos.length >= 3) {
    const ids = videos.map((v) => v.id).join(', ');
    out.push({
      id: `cmp-tier-set`,
      score: 77,
      text: `Across ${ids}, which tier differences show up in network ranks 2 and 3 rather than Visual?`,
    });
  }
  return out;
}

function caveatText(n) {
  return `What are the biggest caveats of this analysis at N=${n}?`;
}

function caveatCandidate(n) {
  return { id: 'caveat-n', score: 50, text: caveatText(n) };
}

export function buildSalientSuggestions(knowledge, videoIds = [], { seed = 0, count = 4 } = {}) {
  const map = byIdMap(knowledge);
  const allVideos = knowledge?.videos || [];
  const pack = packStats(allVideos);
  const ids = [...new Set((videoIds || []).filter((id) => map.has(id)))];
  const focusVideos = ids.map((id) => map.get(id));

  const candidates = [caveatCandidate(pack.n)];
  if (focusVideos.length >= 2) {
    candidates.push(...compareCandidates(focusVideos));
    for (const v of focusVideos) {
      candidates.push(...videoCandidates(v, pack).filter((c) => c.score >= 70));
    }
  } else if (focusVideos.length === 1) {
    candidates.push(...videoCandidates(focusVideos[0], pack));
  } else if (allVideos.length) {
    candidates.push(
      {
        id: 'pack-breakout',
        score: 70,
        text: 'Why did the breakout video outperform the rest on amplification?',
      },
      {
        id: 'pack-hook',
        score: 60,
        text: 'Why can a negative hook slope still land in the strong tier?',
      },
      {
        id: 'pack-networks',
        score: 55,
        text: `Is Visual dominance meaningful across these ${pack.n} videos?`,
      },
      {
        id: 'pack-amp',
        score: 45,
        text: 'Which video has the highest amplification, and what is its like rate?',
      },
    );
  }

  const best = new Map();
  for (const c of candidates) {
    const prev = best.get(c.text);
    if (!prev || c.score > prev.score) best.set(c.text, c);
  }
  const unique = [...best.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  const caveat = unique.find((c) => c.id === 'caveat-n') || caveatCandidate(pack.n);
  const rest = unique.filter((c) => c.id !== 'caveat-n');
  const offset = rest.length ? (Number(seed) || 0) % rest.length : 0;
  const rotated = rest.length ? [...rest.slice(offset), ...rest.slice(0, offset)] : [];

  const picked = [];
  const seen = new Set();
  for (const c of rotated) {
    if (picked.length >= count - 1) break;
    if (seen.has(c.text)) continue;
    seen.add(c.text);
    picked.push(c.text);
  }
  if (!seen.has(caveat.text)) {
    picked.push(caveat.text);
    seen.add(caveat.text);
  }
  for (const c of unique) {
    if (picked.length >= count) break;
    if (seen.has(c.text)) continue;
    seen.add(c.text);
    picked.push(c.text);
  }
  return picked.slice(0, count);
}

export function suggestionFocusIds({ mode, selId, compareIds, viewMoment }) {
  if (mode === 'compare') {
    const ids = (compareIds || []).filter(Boolean);
    if (ids.length) return ids;
  }
  if (selId) return [selId];
  if (viewMoment?.videoId) return [viewMoment.videoId];
  return [];
}
