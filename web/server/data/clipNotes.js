import notes from './notes.json' with { type: 'json' };

const EMPTY = { format: '', key_elements: '', relatability_hook: '' };

export function notesFor(videoId) {
  const row = notes?.[videoId];
  if (!row || typeof row !== 'object') return { ...EMPTY };
  return {
    format: String(row.format || ''),
    key_elements: String(row.key_elements || ''),
    relatability_hook: String(row.relatability_hook || ''),
  };
}
