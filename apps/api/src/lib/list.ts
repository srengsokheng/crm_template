import type { ListQuery } from '@crm/shared';
import { and, q, raw, sql, type Fragment } from '../db/index.ts';
import { badRequest } from './errors.ts';
import { camel } from './records.ts';

export interface ListSpec {
  /** SELECT list (without the SELECT keyword). */
  select: Fragment;
  /** FROM … JOIN … clause (without FROM). */
  from: Fragment;
  where: (Fragment | null | undefined | false)[];
  search?: (term: string) => Fragment;
  /** public sort key → trusted SQL expression */
  sorts: Record<string, string>;
  defaultSort: string;
  /** Optional aggregate select evaluated over the full filtered set, e.g. `sum(d.amount) AS amount_sum`. */
  aggregates?: Fragment;
}

export interface ListResult<T> { data: T[]; page: number; pageSize: number; total: number; aggregates?: Record<string, unknown> }

export function parseSort(sort: string | undefined, spec: ListSpec): Fragment {
  const parts = (sort || spec.defaultSort).split(',').map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  for (const p of parts) {
    const desc = p.startsWith('-');
    const key = desc ? p.slice(1) : p;
    const expr = spec.sorts[key];
    if (!expr) throw badRequest(`Unknown sort field "${key}"`);
    out.push(`${expr} ${desc ? 'DESC' : 'ASC'} NULLS LAST`);
  }
  out.push('1 DESC'); // stable tiebreaker: first select column is the id
  return raw(out.join(', ')) as unknown as Fragment;
}

export async function runList<T>(spec: ListSpec, query: ListQuery): Promise<ListResult<T>> {
  const where = and([...spec.where, query.q ? spec.search?.(query.q) : null]);
  const order = parseSort(query.sort, spec);
  const offset = (query.page - 1) * query.pageSize;
  const rows = await q<T & { __total: number }>(sql`
    SELECT ${spec.select}, count(*) OVER() AS __total
    FROM ${spec.from}
    WHERE ${where}
    ORDER BY ${order}
    LIMIT ${query.pageSize} OFFSET ${offset}`);
  let total = rows[0]?.__total ?? 0;
  if (rows.length === 0 && query.page > 1) {
    const c = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM ${spec.from} WHERE ${where}`);
    total = c[0]?.n ?? 0;
  }
  let aggregates: Record<string, unknown> | undefined;
  if (spec.aggregates) {
    aggregates = camel((await q(sql`SELECT ${spec.aggregates} FROM ${spec.from} WHERE ${where}`))[0]);
  }
  const data = rows.map((r) => { const { __total, ...rest } = r; void __total; return rest as T; });
  return { data, page: query.page, pageSize: query.pageSize, total: Number(total), aggregates };
}

/** Helpers to read typed filters from the loose query object. */
export const qs = {
  str(v: unknown): string | undefined { return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined; },
  id(v: unknown): number | undefined { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : undefined; },
  ids(v: unknown): number[] | undefined {
    if (typeof v !== 'string' || !v) return undefined;
    const arr = v.split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
    return arr.length ? arr : undefined;
  },
  date(v: unknown): string | undefined { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v : undefined; },
};

export const likeTerm = (t: string) => `%${t.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
