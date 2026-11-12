export const COMPARE_NEEDS_ANOTHER = 'Another reel is needed before Classy can compare.';
export const OPEN_A_REEL = 'Open a reel first.';

export function reelLabel(reel, reels) {
  const account = String(reel?.account || '').trim();
  const id = String(reel?.id || '').trim();
  if (!account) return id;
  const same = (Array.isArray(reels) ? reels : []).filter((row) => String(row?.account || '').trim() === account);
  if (same.length > 1 && id) return `${account} (${id})`;
  return account;
}

export function answerSubject(mode, reels, selectedIds) {
  const list = Array.isArray(reels) ? reels : [];
  const ids = Array.isArray(selectedIds) ? selectedIds.filter(Boolean) : [];
  const picked = ids.map((id) => list.find((row) => row.id === id) || { id, account: '' });
  if (mode === 'compare') {
    if (picked.length < 2) return { ready: false, text: COMPARE_NEEDS_ANOTHER };
    const names = picked.map((reel) => reelLabel(reel, list)).filter(Boolean);
    return { ready: true, text: `Answering ${names.join(', ')}` };
  }
  const reel = picked[0];
  if (!reel) return { ready: false, text: OPEN_A_REEL };
  return { ready: true, text: `Answering ${reelLabel(reel, list)}` };
}
