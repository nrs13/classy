/** Mode ids: UI + prompt. */
export const REPLY_MODES = [
  {
    id: 'marketing',
    label: 'Marketing',
    hint: 'hooks & creative',
    placeholder: 'ask about hooks…',
    register:
      'MARKETING. Marketing/UGC language: hooks, formats, payoff, what to replicate. Keep numbers accurate but secondary. No jargon for its own sake.',
  },
  {
    id: 'analytics',
    label: 'Analytics',
    hint: 'metrics & rankings',
    placeholder: 'ask about rankings…',
    register:
      'ANALYTICS. Analyst language: rankings, deltas, ratios, plain-text arithmetic. Lead with evidence and comparison across the full set.',
  },
  {
    id: 'research',
    label: 'Research',
    hint: 'brain & method',
    placeholder: 'ask about networks…',
    register:
      'RESEARCH. Neuroscience and methods literacy: predicted encoding, Yeo-7 networks, caveats. Never overclaim causality.',
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

export function replyModePreamble(ids) {
  const modes = normalizeReplyModes(ids);
  const lines = modes.map((id) => `- ${getReplyMode(id).register}`).join('\n');
  const closer = 'This sets the register only; the DATA is always the same.\n\n';
  if (modes.length === 1) {
    return `Active reply mode:\n${lines}\n${closer}`;
  }
  return `Active reply modes (${modes.length}). Blend them into ONE answer. Do not write a separate section per mode, do not label the modes, and never restate the same point in two registers. Weight them roughly evenly:\n${lines}\n${closer}`;
}
