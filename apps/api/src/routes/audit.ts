/**
 * Workspace audit log (admins only): every recorded change across records, imports and merges, newest first.
 * Filters: entityType, action, actorId ('automation' for rule-made changes), from/to (dates), q (record title).
 * `format=csv` downloads the filtered rows (max 10,000).
 */
import type { FastifyInstance } from 'fastify';
import { listQuerySchema, toCsv } from '@crm/shared';
import { and, q, sql } from '../db/index.ts';
import { ctxOf } from '../lib/http.ts';
import { likeTerm, qs, runList } from '../lib/list.ts';
import { requireAdmin } from '../lib/permissions.ts';
import { camelAll } from '../lib/records.ts';
import { parse } from '../lib/validate.ts';

const TITLE = sql`CASE e.entity_type
  WHEN 'deal' THEN (SELECT title FROM deals WHERE id = e.entity_id)
  WHEN 'lead' THEN (SELECT title FROM leads WHERE id = e.entity_id)
  WHEN 'contact' THEN (SELECT nullif(trim(coalesce(first_name,'') || ' ' || coalesce(last_name,'')), '') FROM contacts WHERE id = e.entity_id)
  WHEN 'company' THEN (SELECT name FROM companies WHERE id = e.entity_id)
  WHEN 'product' THEN (SELECT name FROM products WHERE id = e.entity_id)
  WHEN 'import' THEN (SELECT file_name FROM imports WHERE id = e.entity_id)
END`;
const GONE = sql`CASE e.entity_type
  WHEN 'deal' THEN NOT EXISTS (SELECT 1 FROM deals WHERE id = e.entity_id AND deleted_at IS NULL)
  WHEN 'lead' THEN NOT EXISTS (SELECT 1 FROM leads WHERE id = e.entity_id AND deleted_at IS NULL)
  WHEN 'contact' THEN NOT EXISTS (SELECT 1 FROM contacts WHERE id = e.entity_id AND deleted_at IS NULL)
  WHEN 'company' THEN NOT EXISTS (SELECT 1 FROM companies WHERE id = e.entity_id AND deleted_at IS NULL)
  WHEN 'product' THEN NOT EXISTS (SELECT 1 FROM products WHERE id = e.entity_id AND deleted_at IS NULL)
  ELSE false END`;

function filters(ctx: { workspaceId: number }, query: Record<string, unknown>) {
  const actor = qs.str(query.actorId);
  return [
    sql`e.workspace_id = ${ctx.workspaceId}`,
    qs.str(query.entityType) ? sql`e.entity_type = ${qs.str(query.entityType)}` : null,
    qs.str(query.action) ? sql`e.action = ${qs.str(query.action)}` : null,
    actor === 'automation' ? sql`e.actor_type = 'automation'` : qs.id(actor) ? sql`e.actor_id = ${qs.id(actor)}` : null,
    qs.date(query.from) ? sql`e.created_at >= ${qs.date(query.from)}::date` : null,
    qs.date(query.to) ? sql`e.created_at < ${qs.date(query.to)}::date + 1` : null,
  ];
}

export async function auditRoutes(app: FastifyInstance) {
  app.get('/audit-log', async (req, reply) => {
    const ctx = ctxOf(req);
    requireAdmin(ctx);
    const query = parse(listQuerySchema, req.query);
    const where = filters(ctx, query);
    const search = (t: string) => sql`(${TITLE}) ILIKE ${likeTerm(t)}`;
    if ((query as Record<string, unknown>).format === 'csv') {
      const rows = await q<Record<string, unknown>>(sql`SELECT e.created_at, coalesce(u.name, CASE e.actor_type WHEN 'automation' THEN 'Automation' ELSE 'System' END) AS actor,
          e.action, e.entity_type, e.entity_id, ${TITLE} AS title, e.changes
        FROM audit_events e LEFT JOIN users u ON u.id = e.actor_id
        WHERE ${and([...where, query.q ? search(query.q) : null])} ORDER BY e.created_at DESC, e.id DESC LIMIT 10000`);
      const csv = toCsv([['When (UTC)', 'Who', 'Action', 'Record type', 'Record id', 'Record', 'Changes'],
        ...rows.map((r) => [(r.created_at as Date).toISOString(), r.actor as string, r.action as string, r.entity_type as string,
          String(r.entity_id), (r.title as string | null) ?? '', JSON.stringify(r.changes)])]);
      reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="audit-log.csv"`);
      return reply.send('﻿' + csv);
    }
    const r = await runList({
      select: sql`e.id, e.created_at, e.action, e.entity_type, e.entity_id, e.changes, e.actor_type, e.actor_id, u.name AS actor_name,
        ${TITLE} AS title, ${GONE} AS gone`,
      from: sql`audit_events e LEFT JOIN users u ON u.id = e.actor_id`,
      where, search, sorts: { createdAt: 'e.created_at' }, defaultSort: '-createdAt',
    }, query);
    return { ...r, data: camelAll(r.data as Record<string, unknown>[]) };
  });

  /** Values for the filter menus: actions and record types that actually occur in this workspace. */
  app.get('/audit-log/facets', async (req) => {
    const ctx = ctxOf(req);
    requireAdmin(ctx);
    const [actions, types] = await Promise.all([
      q<{ action: string }>(sql`SELECT DISTINCT action FROM audit_events WHERE workspace_id = ${ctx.workspaceId} ORDER BY action`),
      q<{ entity_type: string }>(sql`SELECT DISTINCT entity_type FROM audit_events WHERE workspace_id = ${ctx.workspaceId} ORDER BY entity_type`),
    ]);
    return { actions: actions.map((a) => a.action), entityTypes: types.map((t) => t.entity_type) };
  });
}
