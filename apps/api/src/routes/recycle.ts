import type { FastifyInstance } from 'fastify';
import type { PermissionEntity } from '@crm/shared';
import { join, q, q1, raw, sql, tx } from '../db/index.ts';
import { audit } from '../lib/audit.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { ctxOf } from '../lib/http.ts';
import { assertOnRecord, requireAny, scopeOf } from '../lib/permissions.ts';
import { camelAll } from '../lib/records.ts';

const ENTITIES: Record<string, { table: string; perm: PermissionEntity; title: string; owner: boolean }> = {
  leads: { table: 'leads', perm: 'lead', title: 'title', owner: true },
  deals: { table: 'deals', perm: 'deal', title: 'title', owner: true },
  contacts: { table: 'contacts', perm: 'contact', title: "trim(coalesce(first_name,'') || ' ' || coalesce(last_name,''))", owner: true },
  companies: { table: 'companies', perm: 'company', title: 'name', owner: true },
  products: { table: 'products', perm: 'product', title: 'name', owner: false },
};

export const RETENTION_DAYS = 30;

export async function recycleRoutes(app: FastifyInstance) {
  app.delete<{ Params: { entity: string; id: string } }>('/:entity/:id', async (req, reply) => {
    const ctx = ctxOf(req);
    const e = ENTITIES[req.params.entity];
    if (!e) return reply.callNotFound();
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw badRequest('Invalid id');
    await tx(async (db) => {
      const row = await q1<{ owner_id?: number; visibility?: string; title: string }>(sql`SELECT ${raw(e.owner ? 'owner_id, visibility,' : '')} ${raw(e.title)} AS title
        FROM ${raw(e.table)} WHERE id = ${id} AND workspace_id = ${ctx.workspaceId} AND deleted_at IS NULL`, db);
      if (!row) throw notFound();
      if (e.owner) assertOnRecord(ctx, e.perm, 'delete', row);
      else requireAny(ctx, e.perm, 'delete');
      await q(sql`UPDATE ${raw(e.table)} SET deleted_at = now()
        ${e.table === 'products' ? sql`` : sql`, deleted_by = ${ctx.userId}`} WHERE id = ${id}`, db);
      await audit(db, ctx, e.perm, id, 'deleted', { title: [row.title, null] });
    });
    return reply.code(204).send();
  });

  app.post<{ Params: { entity: string; id: string } }>('/:entity/:id/restore', async (req, reply) => {
    const ctx = ctxOf(req);
    const e = ENTITIES[req.params.entity];
    if (!e) return reply.callNotFound();
    const id = Number(req.params.id);
    await tx(async (db) => {
      const row = await q1<{ owner_id?: number; visibility?: string }>(sql`SELECT ${raw(e.owner ? 'owner_id, visibility' : 'id')}
        FROM ${raw(e.table)} WHERE id = ${id} AND workspace_id = ${ctx.workspaceId} AND deleted_at IS NOT NULL`, db);
      if (!row) throw notFound('Deleted record');
      if (e.owner) assertOnRecord(ctx, e.perm, 'delete', row);
      else requireAny(ctx, e.perm, 'delete');
      await q(sql`UPDATE ${raw(e.table)} SET deleted_at = NULL ${e.table === 'products' ? sql`` : sql`, deleted_by = NULL`} WHERE id = ${id}`, db);
      await audit(db, ctx, e.perm, id, 'restored');
    });
    return { ok: true, id };
  });

  app.get('/recycle-bin', async (req) => {
    const ctx = ctxOf(req);
    const parts = Object.entries(ENTITIES)
      .filter(([, e]) => scopeOf(ctx, e.perm, 'delete') !== 'none')
      .map(([key, e]) => sql`SELECT ${key}::text AS entity, id, ${raw(e.title)} AS title, deleted_at,
          ${e.table === 'products' ? sql`NULL::bigint` : sql`deleted_by`} AS deleted_by
        FROM ${raw(e.table)} WHERE workspace_id = ${ctx.workspaceId} AND deleted_at IS NOT NULL
          AND deleted_at > now() - ${RETENTION_DAYS + ' days'}::interval
          ${e.owner && !ctx.isAdmin && scopeOf(ctx, e.perm, 'delete') !== 'all' ? sql`AND owner_id = ANY(${ctx.teamUserIds})` : sql``}`);
    if (!parts.length) return { data: [], retentionDays: RETENTION_DAYS };
    const rows = await q(sql`SELECT x.*, u.name AS deleted_by_name FROM (${join(parts, ' UNION ALL ')}) x
      LEFT JOIN users u ON u.id = x.deleted_by ORDER BY x.deleted_at DESC LIMIT 500`);
    return { data: camelAll(rows), retentionDays: RETENTION_DAYS };
  });
}
