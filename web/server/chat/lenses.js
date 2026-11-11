import { normalizeReplyModes, REPLY_MODES } from '../../src/lib/replyModes.js';

const VOICE = {
  marketing: 'The practical reading:',
  analytics: 'The record:',
  research: 'The method:',
};

export function applyLenses(base, modes) {
  const text = String(base || '');
  const selected = normalizeReplyModes(modes);
  if (!text || !selected.length) return text;
  return selected.map((id) => {
    const label = REPLY_MODES.find((mode) => mode.id === id).label;
    return `${label}\n${VOICE[id]}\n${text}`;
  }).join('\n\n');
}
