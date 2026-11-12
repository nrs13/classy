/**
 * Builds the throwaway catalog the pull-request tests expect.
 * Refuses to run unless the workflow sets CLASSY_CI_CATALOG=1.
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';

if (process.env.CLASSY_CI_CATALOG !== '1') {
  console.error('Set CLASSY_CI_CATALOG=1 to build the throwaway catalog.');
  process.exit(1);
}

const database = 'classy';
const schema = readFileSync(new URL('../../catalog/schema.sql', import.meta.url), 'utf8');
const admin = new pg.Client({ database: 'postgres' });
await admin.connect();
const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
if (!existing.rowCount) await admin.query(`CREATE DATABASE ${database}`);
await admin.end();

const client = new pg.Client({ database });
await client.connect();
await client.query(schema);
await client.query(`
  INSERT INTO snapshot (id, complete, embedding_model, embedding_dim, embedding_profile)
  VALUES ('ci', true, 'fake', 4, 'test|fake|4|document')
  ON CONFLICT (id) DO NOTHING;
  UPDATE pointer SET snapshot_id = 'ci' WHERE id = 1;
  INSERT INTO clip (
    video_id, snapshot_id, language, account, duration,
    plays, likes, comments, followers, like_rate, amplification,
    hook_slope, peak_mean_abs, sustain_ratio
  ) VALUES (
    'v002', 'ci', 'en', 'demo', 7,
    31300000, 1, 1, 5750, 0.01, 5443,
    0.0061, 0.071, 1
  ) ON CONFLICT (snapshot_id, video_id) DO NOTHING;
`);
await client.end();
