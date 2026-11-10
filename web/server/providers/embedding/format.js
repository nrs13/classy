/**
 * Text rules applied before embedding. catalog/providers/embedding.py applies the same rules;
 * catalog/providers/format_fixture.json pins both. Limits count code points, not UTF-16 units.
 */
export const MAX_DOCUMENT_CHARS = 4000;
export const MAX_QUERY_CHARS = 1000;

const ZERO_WIDTH = /\u200b|\u200c|\u200d|\u2060|\ufeff/g;
const SPACE = /[ \t\n\r\f\v\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/g;

function clean(text, max) {
  const flat = String(text ?? '')
    .normalize('NFC')
    .replace(ZERO_WIDTH, '')
    .replace(SPACE, ' ')
    .trim();
  const points = Array.from(flat);
  return points.length > max ? points.slice(0, max).join('').trimEnd() : flat;
}

export function formatDocument(text) {
  return clean(text, MAX_DOCUMENT_CHARS);
}

export function formatQuery(text) {
  return clean(text, MAX_QUERY_CHARS);
}
