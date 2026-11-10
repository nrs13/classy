import assert from 'node:assert/strict';
import test from 'node:test';
import { productionDatabaseBlocked } from '../server/repo/productionGuard.js';

const neon = ['postgresql', '://example@ep-example.neon.tech/neondb'].join('');

test('a local database is not treated as production', () => {
  assert.equal(productionDatabaseBlocked({ DATABASE_URL: 'postgresql:///classy' }), false);
});

test('a Neon URL is blocked when the branch is production or unnamed', () => {
  assert.equal(productionDatabaseBlocked({ DATABASE_URL: neon, NEON_BRANCH: 'production' }), true);
  assert.equal(productionDatabaseBlocked({ DATABASE_URL: neon }), true);
});

test('the dev branch is allowed, and an explicit override is allowed', () => {
  assert.equal(productionDatabaseBlocked({ DATABASE_URL: neon, NEON_BRANCH: 'dev' }), false);
  assert.equal(
    productionDatabaseBlocked({
      DATABASE_URL: neon,
      NEON_BRANCH: 'production',
      CLASSY_ALLOW_PRODUCTION: '1',
    }),
    false,
  );
});
