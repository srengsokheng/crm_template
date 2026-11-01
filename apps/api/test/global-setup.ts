import pg from 'pg';

/** Recreate the test schema from scratch before the run. */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://crm:crm@127.0.0.1:5432/crm_test';
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await c.end();
  process.env.DATABASE_URL = url;
  const { migrate } = await import('../src/db/migrate.ts');
  const { pool } = await import('../src/db/pool.ts');
  await migrate(() => {});
  await pool.end();
}
