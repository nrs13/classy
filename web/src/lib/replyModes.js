export const REPLY_MODES = [
  {
    id: 'marketing',
    label: 'Marketing',
    hint: 'hooks & creative',
    placeholder: 'ask about hooks…',
    register:
      'Marketing. Give practical hook and creative advice, and what to try next, in plain language.',
  },
  {
    id: 'analytics',
    label: 'Analytics',
    hint: 'metrics & rankings',
    placeholder: 'ask about rankings…',
    register:
      'Analytics. Give exact numbers, comparisons between clips, ranges, and caveats. Make no claim beyond the data.',
  },
  {
    id: 'research',
    label: 'Research',
    hint: 'brain & method',
    placeholder: 'ask about networks…',
    register:
      'Research. Explain how the metric is computed, the assumptions and limits, and what the data cannot show.',
  },
];

const REPLY_MODE_IDS = REPLY_MODES.map((m) => m.id);
export const DEFAULT_REPLY_MODES = [REPLY_MODES[0].id];

function getReplyMode(id) {
  return REPLY_MODES.find((m) => m.id === id) || REPLY_MODES[0];
}

export function normalizeReplyModes(ids) {
  const wanted = new Set(Array.isArray(ids) ? ids : []);
  const kept = REPLY_MODE_IDS.filter((id) => wanted.has(id));
  return kept.length ? kept : [...DEFAULT_REPLY_MODES];
}

export function toggleReplyMode(active, id) {
  const current = normalizeReplyModes(active);
  if (!REPLY_MODE_IDS.includes(id)) return current;
  if (!current.includes(id)) return normalizeReplyModes([...current, id]);
  if (current.length === 1) return current;
  return current.filter((m) => m !== id);
}

export function replyModeSummary(active) {
  const modes = normalizeReplyModes(active).map(getReplyMode);
  if (modes.length === 1) return `${modes[0].label} · ${modes[0].hint}`;
  return modes.map((m) => m.label).join(' + ');
}

export function replyModePlaceholder(active) {
  const modes = normalizeReplyModes(active);
  return modes.length === 1 ? getReplyMode(modes[0]).placeholder : 'ask classy…';
}
