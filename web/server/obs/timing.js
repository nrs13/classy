export function createTimer() {
  const started = performance.now();
  const ms = {};
  return {
    ms,
    async stage(name, fn) {
      const t0 = performance.now();
      try {
        return await fn();
      } finally {
        ms[name] = Math.round((performance.now() - t0) * 10) / 10;
      }
    },
    total() {
      ms.total = Math.round((performance.now() - started) * 10) / 10;
      return ms.total;
    },
    serverTiming() {
      return Object.entries(ms)
        .map(([name, value]) => `${name};dur=${value}`)
        .join(', ');
    },
  };
}
