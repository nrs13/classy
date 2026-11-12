export function wholeCount(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  return Math.round(x).toLocaleString('en-US');
}

export function compactCount(n) {
  if (n == null) return null;
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  if (x >= 1e6) return (x / 1e6).toFixed(1) + 'M';
  if (x >= 1e3) return (x / 1e3).toFixed(1) + 'K';
  return String(x);
}

export function amplificationLabel(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  if (Math.abs(x) >= 100) return `${Math.round(x).toLocaleString('en-US')}×`;
  return `${x.toFixed(2)}×`;
}

export function fixed4(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x.toFixed(4) : null;
}
