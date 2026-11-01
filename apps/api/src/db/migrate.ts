import { readdir, readFile } from 'node:fs/promises';
import { pool } from './pool.ts';

export async function migrate(log = console.log): Promise<void> {
  const dir = new URL('./migrations/', import.meta.url);
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(726354)');
    await client.query('CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await client.query('SELECT name FROM _migrations')).rows.map((r) => r.name as string));
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      if (done.has(f)) continue;
      const text = await readFile(new URL(f, dir), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(text);
        await client.query('INSERT INTO _migrations (name) VALUES ($1)', [f]);
        await client.query('COMMIT');
        log(`applied ${f}`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(726354)').catch(() => {});
    client.release();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
}
