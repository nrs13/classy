import { IcosahedronGeometry } from 'three';

const DATA = '/data';

async function fetchArrayBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('text/html')) throw new Error(`${url}: not found (html fallback)`);
  return res.arrayBuffer();
}

export async function loadManifest() {
  try {
    const res = await fetch(`${DATA}/manifest.json`);
    if (!res.ok) throw new Error(String(res.status));
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('text/html')) throw new Error('manifest html fallback');
    const m = await res.json();
    return { ...m, synthetic: false };
  } catch {
    return syntheticManifest();
  }
}

function syntheticManifest() {
  const demo = [
    ['B_V1', 'thelilystudylog', 'breakout', 6546346, 415566, 363, 915, 7.166],
    ['A_V1', 'rosestudydiary', 'strong', 378305, 30504, 277, 12900, 73.1],
    ['A_V5', 'rosestudydiary', 'strong', 94913, 5442, 79, 12900, 85.733],
    ['A_V3', 'rosestudydiary', 'mid', 20328, 438, 23, 12900, 44.422],
    ['A_V4', 'rosestudydiary', 'tail', 12102, 83, 0, 12900, 27.236],
    ['B_V5', 'thelilystudylog', 'tail', 10211, 74, 1, 915, 7.2],
    ['A_V2', 'rosestudydiary', 'tail', 2675, 32, 2, 12900, 84.451],
    ['B_V4', 'thelilystudylog', 'tail', 2627, 23, 0, 915, 11.266],
    ['B_V2', 'thelilystudylog', 'tail', 1980, 26, 0, 915, 8.0],
    ['B_V3', 'thelilystudylog', 'tail', 1717, 13, 0, 915, 8.055],
  ];
  const videos = demo.map(([id, account, tier, plays, likes, comments, followers, duration]) => ({
    id,
    account,
    tier,
    group: id[0],
    video: `videos/${id}.mp4`,
    duration,
    frames: 60,
    metrics: {
      plays,
      likes,
      comments,
      followers,
      like_rate: +(likes / plays).toFixed(6),
      amplification: +(plays / followers).toFixed(2),
    },
    annotations: {},
    features: {},
  }));
  return { videos, vertexCount: null, hemiSplit: null, synthetic: true };
}

async function loadAtlas(manifest, vertexCount) {
  const atlas = manifest?.atlas;
  if (
    manifest?.synthetic ||
    !atlas?.requiresRealMesh ||
    atlas?.syntheticMeshCompatible !== false ||
    !atlas?.labels
  ) {
    return null;
  }
  try {
    const labels = new Uint8Array(await fetchArrayBuffer(`${DATA}/${atlas.labels}`));
    if (labels.length !== vertexCount || atlas.vertexCount !== vertexCount) return null;
    return {
      labels,
      name: atlas.name,
      scope: atlas.scope,
      networkNames: atlas.networkNames || {},
    };
  } catch {
    return null;
  }
}

export async function loadBrain(manifest) {
  try {
    const [posBuf, idxBuf] = await Promise.all([
      fetchArrayBuffer(`${DATA}/brain_pos.bin`),
      fetchArrayBuffer(`${DATA}/brain_idx.bin`),
    ]);
    const positions = new Float32Array(posBuf);
    const indices = new Uint32Array(idxBuf);
    const vertexCount = positions.length / 3;
    const atlas = await loadAtlas(manifest, vertexCount);
    return { positions, indices, vertexCount, atlas, synthetic: false };
  } catch {
    const geo = new IcosahedronGeometry(1.25, 4);
    const positions = Float32Array.from(geo.attributes.position.array);
    for (let i = 0; i < positions.length; i += 3) {
      positions[i] *= 1.4;
      positions[i + 1] *= 0.88;
      positions[i + 2] *= 1.12;
    }
    const indices = geo.index ? Uint32Array.from(geo.index.array) : null;
    const vertexCount = positions.length / 3;
    geo.dispose();
    return { positions, indices, vertexCount, atlas: null, synthetic: true };
  }
}

export async function loadActivation(video, brain) {
  if (!brain.synthetic) {
    try {
      const buf = await fetchArrayBuffer(`${DATA}/act/${video.id}.bin`);
      const data = new Uint8Array(buf);
      const n = brain.vertexCount;
      const frames = n > 0 ? Math.round(data.length / n) : 0;
      if (frames > 0 && data.length === frames * n) {
        return { data, frames, vertexCount: n, synthetic: false };
      }
    } catch {
      /* fall through to synthetic */
    }
  }
  return syntheticActivation(video, brain);
}

function syntheticActivation(video, brain) {
  const frames = video.frames || 60;
  const n = brain.vertexCount;
  const pos = brain.positions;
  const data = new Uint8Array(frames * n);
  const id = video.id || 'x';
  const seed = id.charCodeAt(0) + id.charCodeAt(id.length - 1);
  for (let f = 0; f < frames; f++) {
    const t = (f / frames) * Math.PI * 2;
    for (let v = 0; v < n; v++) {
      const x = pos[v * 3];
      const y = pos[v * 3 + 1];
      const z = pos[v * 3 + 2];
      const val =
        0.55 +
        0.35 * Math.sin(t * 1.4 + y * 2.4 + seed * 0.11) * Math.cos(x * 1.8 - t + seed * 0.05) +
        0.1 * Math.sin(z * 3 + t * 0.7);
      data[f * n + v] = Math.max(0, Math.min(255, Math.round(val * 255)));
    }
  }
  return { data, frames, vertexCount: n, synthetic: true };
}
