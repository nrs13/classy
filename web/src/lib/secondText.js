const WORD = /[^\W\d_]+/gu;

function tokens(text) {
  return String(text || '').toLowerCase().match(WORD) || [];
}

function sentencesOf(items) {
  const out = [];
  for (const item of items || []) {
    const sentence = String(item?.sentence || '').replace(/\s+/g, ' ').trim();
    if (sentence) out.push(sentence);
  }
  return out;
}

function nearDuplicate(candidate, prior) {
  const a = new Set(tokens(candidate));
  const b = new Set(tokens(prior));
  if (!a.size || !b.size) return false;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / Math.min(a.size, b.size) >= 0.6;
}

function finish(text) {
  const body = String(text || '').replace(/\s+/g, ' ').trim();
  if (!body) return '';
  const headed = body[0] === body[0].toLowerCase() ? body[0].toUpperCase() + body.slice(1) : body;
  return /[.!?]$/.test(headed) ? headed : `${headed}.`;
}

/** Most informative stored sentence, with a later near-duplicate dropped. */
export function fallbackSecondText(scenes, outcomes) {
  const ordered = [...sentencesOf(scenes), ...sentencesOf(outcomes)];
  const kept = [];
  for (const sentence of ordered) {
    if (kept.some((prior) => nearDuplicate(sentence, prior))) continue;
    kept.push(sentence);
  }
  if (!kept.length) return '';
  const richest = kept.reduce((best, sentence) => (
    tokens(sentence).length > tokens(best).length ? sentence : best
  ));
  return finish(richest);
}

/** Packed sentence when the snapshot has one, otherwise the deterministic fallback. */
export function secondText(row) {
  const packed = String(row?.happens || '').replace(/\s+/g, ' ').trim();
  if (packed) return packed;
  return fallbackSecondText(row?.scenes, row?.outcomes);
}
