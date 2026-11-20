import { apiFetch } from './apiFetch.js';

const DATA = '/data';

const YEO7 = {
  name: 'Yeo-7',
  scope: 'coarse 7-network cortical parcellation',
  labels: 'atlas_yeo7_labels.bin',
  networkNames: {
    1: 'Visual',
    2: 'Somatomotor',
    3: 'Dorsal Attention',
    4: 'Ventral Attention',
    5: 'Limbic',
    6: 'Frontoparietal',
    7: 'Default Mode Network',
  },
};

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

export async function loadBrain(manifest, { signal } = {}) {
  try {
    const [posBuf, idxBuf, labelsBuf] = await Promise.all([
      fetchArrayBuffer(`${DATA}/brain_pos.bin`, signal),
      fetchArrayBuffer(`${DATA}/brain_idx.bin`, signal),
      fetchArrayBuffer(`${DATA}/${YEO7.labels}`, signal).catch(() => null),
    ]);
    const positions = new Float32Array(posBuf);
    const indices = new Uint32Array(idxBuf);
    const vertexCount = positions.length / 3;
    const labels = labelsBuf ? new Uint8Array(labelsBuf) : null;
    const atlas =
      labels && labels.length === vertexCount
        ? {
            labels,
            name: manifest?.atlas?.name || YEO7.name,
            scope: manifest?.atlas?.scope || YEO7.scope,
            networkNames: manifest?.atlas?.networkNames || YEO7.networkNames,
          }
        : null;
    return { positions, indices, vertexCount, atlas, synthetic: false };
  } catch (err) {
    if (signal?.aborted || err?.name === 'AbortError') {
      const aborted = new Error('aborted');
      aborted.name = 'AbortError';
      throw aborted;
    }
    const { IcosahedronGeometry } = await import('three');
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
