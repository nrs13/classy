/**
 * Local scripts may use a Neon dev branch. They refuse the production branch
 * unless CLASSY_ALLOW_PRODUCTION=1. A local Postgres URL is allowed.
 * The URL is never included in the error.
 */
export function productionDatabaseBlocked(env = process.env) {
  if (env.CLASSY_ALLOW_PRODUCTION === '1') return false;
  const raw = String(env.DATABASE_URL || '');
  let host = '';
  try {
    host = new URL(raw.replace(/^postgresql:/i, 'postgres:')).hostname || '';
  } catch {
    host = '';
  }
  if (!host.endsWith('.neon.tech')) return false;
  const branch = String(env.NEON_BRANCH || '');
  return branch === '' || branch === 'production';
}

export function assertDevDatabase(env = process.env) {
  if (productionDatabaseBlocked(env)) {
    throw new Error(
      'Refusing the production database. Use the dev branch, or set CLASSY_ALLOW_PRODUCTION=1 for this command.',
    );
  }
}
