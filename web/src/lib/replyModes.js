export const REPLY_MODES = [
  {
    id: 'marketing',
    label: 'Marketing',
    hint: 'hooks & creative',
    placeholder: 'ask about hooks…',
  },
  {
    id: 'analytics',
    label: 'Analytics',
    hint: 'metrics & rankings',
    placeholder: 'ask about rankings…',
  },
  {
    id: 'research',
    label: 'Research',
    hint: 'brain & method',
    placeholder: 'ask about networks…',
  },
];

const REPLY_MODE_IDS = REPLY_MODES.map((m) => m.id);
export const DEFAULT_REPLY_MODES = [];

function modeById(id) {
  return REPLY_MODES.find((mode) => mode.id === id);
}

export function normalizeReplyModes(ids) {
  const wanted = new Set(Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : []);
  return REPLY_MODE_IDS.filter((id) => wanted.has(id));
}

export function toggleReplyMode(active, id) {
  const current = normalizeReplyModes(active);
  if (!REPLY_MODE_IDS.includes(id)) return current;
  if (current.includes(id)) return current.filter((mode) => mode !== id);
  return normalizeReplyModes([...current, id]);
}

export function replyModeSummary(active) {
  const modes = normalizeReplyModes(active);
  if (!modes.length) return 'Ask classy';
  if (modes.length === 1) {
    const mode = modeById(modes[0]);
    return `${mode.label} · ${mode.hint}`;
  }
  return modes.map((id) => modeById(id).label).join(' + ');
}

export function replyModePlaceholder(active) {
  const modes = normalizeReplyModes(active);
  if (modes.length !== 1) return 'ask classy…';
  return modeById(modes[0]).placeholder;
}
