const FIND = /\bfind\b|\bshow me reels\b|\bwhich reels\b|\bany reels about\b/i;

export function asksToFind(text) {
  return FIND.test(String(text || ''));
}

function hitLine(row) {
  const line = String(row?.best?.quote || row?.line || '').replace(/\s+/g, ' ').trim().slice(0, 220);
  return {
    id: String(row?.videoId || row?.id || '').trim(),
    account: String(row?.account || '').trim(),
    line,
  };
}

/** Search hits for a find question. `search` is injectable so tests never call the library. */
export async function findHits(message, search) {
  if (!asksToFind(message) || typeof search !== 'function') return [];
  const found = await search({ q: message, understand: false, limit: 5 });
  return (found?.results || []).slice(0, 5).map(hitLine).filter((row) => row.id);
}
