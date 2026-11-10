/**
 * Cell of a video's frame sprite for a moment. sprite_meta (catalog/frames.py):
 *   { cols, rows, count, interval, width, height }   frame i is the frame at i * interval seconds.
 */
export function frameOf(meta, tSec) {
  if (!meta || !(meta.count > 0) || !(meta.interval > 0) || !(meta.cols > 0)) return null;
  const t = Math.max(0, Number(tSec) || 0);
  const index = Math.min(meta.count - 1, Math.round(t / meta.interval));
  return { col: index % meta.cols, row: Math.floor(index / meta.cols) };
}
