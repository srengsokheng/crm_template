import type { Db } from './pool.ts';
import { query as runQuery, one as runOne, pool, tx } from './pool.ts';
import { build, type Fragment } from './sql.ts';

export const q = <T = Record<string, unknown>>(f: Fragment, db: Db = pool) => runQuery<T>(db, build(f));
export const q1 = <T = Record<string, unknown>>(f: Fragment, db: Db = pool) => runOne<T>(db, build(f));
export { pool, tx };
export type { Db };
export { sql, raw, join, and, or, empty } from './sql.ts';
export type { Fragment } from './sql.ts';
