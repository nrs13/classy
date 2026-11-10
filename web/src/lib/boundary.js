export const APP_FALLBACK = 'Something went wrong. Reload the page to continue.';
export const BRAIN_FALLBACK = 'The brain view is unavailable on this device.';

/** A log line with the area and error name only. No message, stack, or path. */
export function boundaryLog(scope, error) {
  const where = String(scope || 'view').replace(/[^\w-]/g, '').slice(0, 24) || 'view';
  const name = String(error?.name || 'Error').replace(/[^\w$]/g, '').slice(0, 40) || 'Error';
  return `[classy] ${where} failed: ${name}`;
}
