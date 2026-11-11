import { IcosahedronGeometry } from 'three';
import { apiFetch } from './apiFetch.js';

const DATA = '/data';

async function fetchArrayBuffer(url, signal) {
  const res = await apiFetch(url, { signal, retries: 0, timeoutMs: 60_000 });
  if (signal?.aborted) {
    const err = new Error('aborted');
    err.name = 'AbortError';
    throw err;
  }
  if (!res.ok) throw new Error(`media ${res.status}`);
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('text/html')) throw new Error('media not found');
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

export const SECONDS_UNAVAILABLE = 'This second is unavailable.';

export function secondsFailed(signal, response) {
  if (signal?.aborted) return false;
  return !response?.ok;
}

/** Abort leaves the screen alone. Any other catalog failure still boots the mesh and shows the retry. */
export function catalogFailurePlan(err, aborted) {
  if (aborted || err?.name === 'AbortError') return null;
  return { catalogError: true, manifest: { videos: [] }, loadBrain: true };
}

export async function loadCatalog(signal) {
  let res;
  try {
    res = await apiFetch('/api/catalog', { signal });
  } catch (err) {
    if (err?.name === 'AbortError' || signal?.aborted) {
      const aborted = new Error('aborted');
      aborted.name = 'AbortError';
      throw aborted;
    }
    const error = new Error('catalog');
    error.code = 'catalog_unavailable';
    throw error;
  }
  if (signal?.aborted) {
    const aborted = new Error('aborted');
    aborted.name = 'AbortError';
    throw aborted;
  }
  if (!res.ok) {
    const error = new Error('catalog');
    error.code = 'catalog_unavailable';
    throw error;
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

export async function loadActivation(video, brain, { signal } = {}) {
  if (!video?.id || !brain || brain.synthetic || signal?.aborted) return null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const meta = await apiFetch(`/api/media?id=${encodeURIComponent(video.id)}&kind=act`, {
        signal,
      });
      if (signal?.aborted || !meta.ok) return null;
      const body = await meta.json();
      if (!body?.url) return null;
      const data = new Uint8Array(await fetchArrayBuffer(body.url, signal));
      const n = brain.vertexCount;
      const frames = n > 0 ? Math.round(data.length / n) : 0;
      if (frames > 0 && data.length === frames * n) {
        return { data, frames, vertexCount: n, synthetic: false };
      }
      return null;
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError') return null;
      if (attempt === 1) return null;
    }
  }
  return null;
}
