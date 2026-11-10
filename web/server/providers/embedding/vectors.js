export function l2normalize(values) {
  let sum = 0;
  for (const v of values) sum += v * v;
  const norm = Math.sqrt(sum);
  if (!norm) return values;
  return values.map((v) => v / norm);
}

export function assertUnit(vector, dim) {
  if (!Array.isArray(vector) || vector.length !== dim) {
    throw new Error(`embedding_dimension_mismatch:${vector?.length}`);
  }
  let sum = 0;
  for (const v of vector) sum += v * v;
  if (Math.abs(Math.sqrt(sum) - 1) > 1e-3) throw new Error('embedding_not_normalized');
  return vector;
}
