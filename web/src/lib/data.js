import { IcosahedronGeometry } from 'three';

const DATA = '/data';

async function fetchArrayBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('text/html')) throw new Error(`${url}: not found (html fallback)`);
  return res.arrayBuffer();
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

export async function loadCatalog() {
  const res = await fetch('/api/catalog');
  if (!res.ok) {
    return { snapshotId: null, videos: [], quoteFloor: null, atlas: null };
  }
  const body = await res.json();
  return {
    snapshotId: body.snapshotId || null,
    quoteFloor: body.quoteFloor,
    atlas: body.atlas || null,
    videos: Array.isArray(body.videos) ? body.videos : [],
    synthetic: false,
  };
}

export async function loadActivation(video, brain) {
  if (!video?.id || !brain || brain.synthetic) return null;
  try {
    const meta = await fetch(`/api/media?id=${encodeURIComponent(video.id)}&kind=act`);
    if (!meta.ok) return null;
    const body = await meta.json();
    if (!body?.url) return null;
    const data = new Uint8Array(await fetchArrayBuffer(body.url));
    const n = brain.vertexCount;
    const frames = n > 0 ? Math.round(data.length / n) : 0;
    if (frames > 0 && data.length === frames * n) {
      return { data, frames, vertexCount: n, synthetic: false };
    }
  } catch {
    return null;
  }
  return null;
}
