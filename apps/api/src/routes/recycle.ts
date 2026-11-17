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
      const row = await q1<{ owner_id?: number; visibility?: string; pipeline_id?: number; title: string }>(sql`SELECT ${raw(e.owner ? 'owner_id, visibility,' : '')}
        ${raw(e.table === 'deals' || e.table === 'leads' ? 'pipeline_id,' : '')} ${raw(e.title)} AS title
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
      const row = await q1<{ owner_id?: number; visibility?: string; pipeline_id?: number; merged_into_id?: number | null }>(sql`SELECT ${raw(e.owner ? 'owner_id, visibility' : 'id')}
        ${raw(e.table === 'deals' || e.table === 'leads' ? ', pipeline_id' : '')}
        ${e.table === 'contacts' || e.table === 'companies' ? sql`, merged_into_id` : sql``}
        FROM ${raw(e.table)} WHERE id = ${id} AND workspace_id = ${ctx.workspaceId} AND deleted_at IS NOT NULL`, db);
      if (!row) throw notFound('Deleted record');
      if (row.merged_into_id) throw badRequest(`This record was merged into #${row.merged_into_id} and can't be restored`);
      if (e.owner) assertOnRecord(ctx, e.perm, 'delete', row);
      else requireAny(ctx, e.perm, 'delete');
      await q(sql`UPDATE ${raw(e.table)} SET deleted_at = NULL ${e.table === 'products' ? sql`` : sql`, deleted_by = NULL`} WHERE id = ${id}`, db);
      await audit(db, ctx, e.perm, id, 'restored');
    });
    return { ok: true, id };
  });

  /** Deleted records, newest first, paged with "Load more" (limit, before = cursor of microseconds|table|id). */
  app.get<{ Querystring: { limit?: string; before?: string } }>('/recycle-bin', async (req) => {
    const ctx = ctxOf(req);
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    let cursor: { us: number; rank: number; id: number } | null = null;
    if (req.query.before) {
      const m = /^(-?\d{1,17})\|(\d)\|(\d{1,15})$/.exec(Buffer.from(String(req.query.before), 'base64url').toString('utf8'));
      if (!m) throw badRequest('Invalid cursor');
      cursor = { us: Number(m[1]), rank: Number(m[2]), id: Number(m[3]) };
    }
    const parts = Object.entries(ENTITIES)
      .filter(([, e]) => scopeOf(ctx, e.perm, 'delete') !== 'none')
      .map(([key, e]) => sql`SELECT ${key}::text AS entity, ${Object.keys(ENTITIES).indexOf(key)}::int AS rank, id, ${raw(e.title)} AS title, deleted_at,
          (extract(epoch from deleted_at) * 1000000)::bigint AS feed_us,
          ${e.table === 'products' ? sql`NULL::bigint` : sql`deleted_by`} AS deleted_by
        FROM ${raw(e.table)} WHERE workspace_id = ${ctx.workspaceId} AND deleted_at IS NOT NULL
          ${e.table === 'contacts' || e.table === 'companies' ? sql`AND merged_into_id IS NULL` : sql``}
          AND deleted_at > now() - ${RETENTION_DAYS + ' days'}::interval
          ${e.owner && !ctx.isAdmin && scopeOf(ctx, e.perm, 'delete') !== 'all' ? sql`AND owner_id = ANY(${ctx.teamUserIds})` : sql``}`);
    if (!parts.length) return { data: [], nextCursor: null, retentionDays: RETENTION_DAYS };
    const rows = await q<{ entity: string; rank: number; id: number; feed_us: number }>(sql`SELECT x.*, u.name AS deleted_by_name FROM (${join(parts, ' UNION ALL ')}) x
      LEFT JOIN users u ON u.id = x.deleted_by
      ${cursor ? sql`WHERE (x.feed_us, x.rank, x.id) < (${cursor.us}::bigint, ${cursor.rank}::int, ${cursor.id}::bigint)` : sql``}
      ORDER BY x.feed_us DESC, x.rank DESC, x.id DESC LIMIT ${limit + 1}`);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor = rows.length > limit && last ? Buffer.from(`${last.feed_us}|${last.rank}|${last.id}`).toString('base64url') : null;
    return { data: camelAll(page.map(({ feed_us: _f, rank: _r, ...r }) => { void _f; void _r; return r; })), nextCursor, retentionDays: RETENTION_DAYS };
  });
}
