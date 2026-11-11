const TTL_MS = 60_000;

export function createIdempotencyStore(now = () => Date.now()) {
  const rows = new Map();
  function sweep(t) {
    for (const [key, row] of rows) {
      if (t - row.at > TTL_MS) rows.delete(key);
    }
  }
  return {
    claim(key) {
      if (!key) return { fresh: true };
      const t = now();
      sweep(t);
      const row = rows.get(key);
      if (!row) {
        rows.set(key, { at: t, pending: true });
        return { fresh: true };
      }
      if (row.pending) return { fresh: false, pending: true };
      return { fresh: false, replay: row.record };
    },
    finish(key, record) {
      if (!key || !rows.has(key)) return;
      const row = rows.get(key);
      row.pending = false;
      row.record = record;
      row.at = now();
    },
  };
}

export const chatSends = createIdempotencyStore();
