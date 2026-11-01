import pg from 'pg';
import { config } from '../config.ts';
import type { SqlQuery } from './sql.ts';

// int8 → number (ids stay well below 2^53); numeric stays string (money); date stays 'YYYY-MM-DD'.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1082, (v) => v);
// int8[] → number[] (reuse the int4[] parser)
pg.types.setTypeParser(1016 as never, pg.types.getTypeParser(1007 as never));

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

export type Db = pg.Pool | pg.PoolClient;

export async function query<T = Record<string, unknown>>(db: Db, q: SqlQuery): Promise<T[]> {
  const res = await db.query(q.text, q.values);
  return res.rows as T[];
}

export async function one<T = Record<string, unknown>>(db: Db, q: SqlQuery): Promise<T | undefined> {
  return (await query<T>(db, q))[0];
}

export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
