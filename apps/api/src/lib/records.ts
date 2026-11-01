import { and, join, q, q1, raw, sql, type Db, pool } from '../db/index.ts';
import { badRequest, conflict, notFound } from './errors.ts';
import type { Ctx } from './context.ts';

const toCamel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

export function camel<T extends object = Record<string, unknown>>(row: Record<string, unknown> | undefined | null): T {
  if (!row) return row as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[toCamel(k)] = v;
  return out as T;
}
export const camelAll = <T extends object = Record<string, unknown>>(rows: Record<string, unknown>[]) => rows.map((r) => camel<T>(r));

/** Pick defined input keys and map camelCase → column names. */
export function pickColumns(input: Record<string, unknown>, map: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, col] of Object.entries(map)) if (input[k] !== undefined) out[col] = input[k];
  return out;
}

export async function insertRow(db: Db, table: string, values: Record<string, unknown>): Promise<Record<string, unknown>> {
  const cols = Object.keys(values);
  const vals = cols.map((c) => {
    const v = values[c];
    return v !== null && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v) ? sql`${JSON.stringify(v)}::jsonb` : sql`${v}`;
  });
  const row = await q1(sql`INSERT INTO ${raw(table)} (${raw(cols.join(', '))}) VALUES (${join(vals)}) RETURNING *`, db);
  return row!;
}

export async function updateRow(db: Db, table: string, id: number, workspaceId: number, values: Record<string, unknown>, opts: { version?: number; bump?: boolean } = {}): Promise<Record<string, unknown>> {
  const sets = Object.entries(values).map(([c, v]) =>
    v !== null && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v) ? sql`${raw(c)} = ${JSON.stringify(v)}::jsonb` : sql`${raw(c)} = ${v}`);
  if (opts.bump !== false) sets.push(sql`version = version + 1`, sql`updated_at = now()`);
  if (!sets.length) return (await q1(sql`SELECT * FROM ${raw(table)} WHERE id = ${id}`, db))!;
  const row = await q1(sql`UPDATE ${raw(table)} SET ${join(sets)}
    WHERE ${and([sql`id = ${id}`, sql`workspace_id = ${workspaceId}`, opts.version !== undefined ? sql`version = ${opts.version}` : null])}
    RETURNING *`, db);
  if (!row) {
    if (opts.version !== undefined) throw conflict('This record was changed by someone else. Reload to see the latest version.');
    throw notFound();
  }
  return row;
}

export async function getActive<T = Record<string, unknown>>(db: Db, table: string, id: number, ctx: Ctx, what = 'Record'): Promise<T> {
  const row = await q1<T>(sql`SELECT * FROM ${raw(table)} WHERE id = ${id} AND workspace_id = ${ctx.workspaceId} AND deleted_at IS NULL`, db);
  if (!row) throw notFound(what);
  return row;
}

/** Ensure referenced ids exist in this workspace (prevents cross-tenant references). */
export async function assertRefs(ctx: Ctx, refs: { table: string; ids: (number | null | undefined)[]; label: string; kind?: string }[], db: Db = pool): Promise<void> {
  for (const r of refs) {
    const ids = Array.from(new Set(r.ids.filter((x): x is number => typeof x === 'number')));
    if (!ids.length) continue;
    const rows = await q<{ id: number }>(sql`SELECT id FROM ${raw(r.table)} WHERE workspace_id = ${ctx.workspaceId} AND id = ANY(${ids})
      ${r.kind ? sql`AND kind = ${r.kind}` : sql``}
      ${['contacts', 'companies', 'leads', 'deals', 'products'].includes(r.table) ? sql`AND deleted_at IS NULL` : sql``}`, db);
    if (rows.length !== ids.length) throw badRequest(`${r.label} not found`);
  }
}

export async function assertMembers(ctx: Ctx, userIds: (number | null | undefined)[], db: Db = pool): Promise<void> {
  const ids = Array.from(new Set(userIds.filter((x): x is number => typeof x === 'number')));
  if (!ids.length) return;
  const rows = await q(sql`SELECT user_id FROM memberships WHERE workspace_id = ${ctx.workspaceId} AND user_id = ANY(${ids}) AND status <> 'disabled'`, db);
  if (rows.length !== ids.length) throw badRequest('User is not a member of this workspace', { ownerId: 'Unknown user' });
}
