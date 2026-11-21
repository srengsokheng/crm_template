/**
 * CSV export of a list with exactly the filters, search and sort the list uses (`?format=csv`).
 * Needs the role's Export permission; rows are limited to the export scope as well as the view scope.
 * Custom fields are added as columns (option labels, user names, yes/no). Max 50,000 rows. Audited as `exported`.
 */
import type { FastifyReply } from 'fastify';
import { toCsv, type ListQuery } from '@crm/shared';
import { and, pool, q, raw, sql } from '../db/index.ts';
import { audit } from './audit.ts';
import type { Ctx } from './context.ts';
import { loadDefs, type FieldDef } from './customFields.ts';
import { hiddenCustomKeys } from './fieldAccess.ts';
import type { FieldEntity } from '@crm/shared';
import { forbidden } from './errors.ts';
import { parseSort, type ListSpec } from './list.ts';
import { scopeOf, scopeWhere } from './permissions.ts';

export const EXPORT_LIMIT = 50_000;
type Entity = 'contact' | 'company' | 'lead' | 'deal';
export type ExportColumn = [header: string, key: string];

const cell = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

function customCell(def: FieldDef, v: unknown, users: Map<number, string>): string {
  if (v === null || v === undefined || v === '') return '';
  const label = (id: unknown) => def.options.find((o) => o.id === id)?.label ?? String(id);
  switch (def.type) {
    case 'select': return label(v);
    case 'multiselect': return Array.isArray(v) ? v.map(label).join('; ') : '';
    case 'boolean': return v ? 'Yes' : 'No';
    case 'user': return users.get(Number(v)) ?? '';
    default: return cell(v);
  }
}

export async function exportCsv(reply: FastifyReply, ctx: Ctx, entity: Entity, spec: ListSpec, query: ListQuery, alias: string,
  columns: ExportColumn[], fileName: string) {
  if (scopeOf(ctx, entity, 'export') === 'none') throw forbidden('Your role cannot export data');
  const where = and([...spec.where, scopeWhere(ctx, entity, 'export', alias), query.q ? spec.search?.(query.q) : null]);
  const rows = await q<Record<string, unknown>>(sql`SELECT ${spec.select}, ${raw(`${alias}.custom`)} AS __custom
    FROM ${spec.from} WHERE ${where} ORDER BY ${parseSort(query.sort, spec)} LIMIT ${EXPORT_LIMIT}`);
  const hidden = hiddenCustomKeys(ctx, entity as FieldEntity);
  const defs = (await loadDefs(ctx.workspaceId, entity)).filter((d) => !hidden.includes(d.key));
  const users = new Map((await q<{ id: number; name: string }>(sql`SELECT u.id, u.name FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.workspace_id = ${ctx.workspaceId}`)).map((u) => [Number(u.id), u.name]));
  const csv = toCsv([
    [...columns.map(([h]) => h), ...defs.map((d) => d.label)],
    ...rows.map((r) => [
      ...columns.map(([, k]) => cell(r[k])),
      ...defs.map((d) => customCell(d, (r.__custom as Record<string, unknown> | null)?.[d.key], users)),
    ]),
  ]);
  const filters = Object.fromEntries(Object.entries(query).filter(([k, v]) => !['page', 'pageSize', 'format'].includes(k) && v !== undefined && v !== ''));
  await audit(pool, ctx, 'export', 0, 'exported', { entity, count: rows.length, truncated: rows.length === EXPORT_LIMIT, filters });
  const stamp = new Date().toISOString().slice(0, 10);
  reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${fileName}-${stamp}.csv"`);
  return reply.send('﻿' + csv);
}
