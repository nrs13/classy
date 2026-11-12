function numericTokens(text) {
  const source = String(text || '');
  const out = [];
  for (const match of source.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const index = match.index || 0;
    if (index > 0 && /v/i.test(source[index - 1])) continue;
    out.push(match[0].replace(/,/g, ''));
  }
  return out;
}

function hasNumber(reply, number) {
  const hay = String(reply || '').replace(/,/g, '');
  const body = number.replace(/\./g, '\\.');
  return new RegExp(`(?<!\\d)${body}(?!\\d)`).test(hay);
}

/** True when every number written in the stored fact still appears in the reply. */
export function numbersKept(fact, reply) {
  return numericTokens(fact).every((number) => hasNumber(reply, number));
}
