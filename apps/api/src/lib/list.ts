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

/**
 * Cursor paging for feeds (newest first): history, inbox, notifications, recycle bin, logs. The cursor is opaque to
 * clients: base64url of "<microseconds since epoch>|<id>" of the last row they have. Microseconds (computed in SQL,
 * see `feedCursorColumn`) because JavaScript dates only keep milliseconds and would skip rows. Rows are ordered by
 * (time DESC, id DESC); the next page continues strictly after the cursor, so equal times are neither skipped nor
 * repeated.
 */
export interface Feed { limit: number; after: { us: number; id: number } | null }
export const FEED_DEFAULT = 50;
export const FEED_MAX = 100;

export function feedQuery(query: { limit?: unknown; before?: unknown }): Feed {
  const n = Number(query.limit ?? FEED_DEFAULT);
  const limit = Number.isInteger(n) && n > 0 ? Math.min(n, FEED_MAX) : FEED_DEFAULT;
  const cursor = typeof query.before === 'string' ? query.before : '';
  if (!cursor) return { limit, after: null };
  const m = /^(-?\d{1,17})\|(\d{1,15})$/.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (!m) throw badRequest('Invalid cursor');
  return { limit, after: { us: Number(m[1]), id: Number(m[2]) } };
}

/** Select this (as `feed_us`) so feedResult can build the cursor; `timeCol` is a trusted column expression. */
export const feedCursorColumn = (timeCol: string) => raw(`(extract(epoch from ${timeCol}) * 1000000)::bigint AS feed_us`);

/** SQL condition for rows after the cursor; `timeCol`/`idCol` are trusted column expressions. */
export function feedWhere(feed: Feed, timeCol: string, idCol: string): Fragment {
  if (!feed.after) return sql`TRUE`;
  return sql`((extract(epoch from ${raw(timeCol)}) * 1000000)::bigint, ${raw(idCol)}) < (${feed.after.us}::bigint, ${feed.after.id}::bigint)`;
}

/** Fetch `limit + 1` rows (with feed_us and id), then pass them here: trims the extra row, sets `nextCursor` if more. */
export function feedResult<T extends { feed_us?: number | string; id: number }>(rows: T[], feed: Feed): { data: Omit<T, 'feed_us'>[]; nextCursor: string | null } {
  const more = rows.length > feed.limit;
  const page = more ? rows.slice(0, feed.limit) : rows;
  const last = page[page.length - 1];
  const data = page.map(({ feed_us: _f, ...rest }) => { void _f; return rest; });
  if (!more || !last) return { data, nextCursor: null };
  return { data, nextCursor: Buffer.from(`${last.feed_us}|${last.id}`).toString('base64url') };
}
