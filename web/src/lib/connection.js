/** Offline hides the banner. Coming back from offline is what asks for a refetch. */
export function applyOnlineState(online, event) {
  if (event === 'offline') return { online: false, refetch: false };
  if (event === 'online') return { online: true, refetch: online === false };
  return { online: Boolean(online), refetch: false };
}
