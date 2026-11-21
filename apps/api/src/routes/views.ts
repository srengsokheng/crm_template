/**
 * Saved list views: a name plus the list's URL filters (search, owner, type, stage, sort, board/list…).
 * Personal views belong to their creator; shared views (owner_id NULL) are visible to everyone in the workspace and
 * only admins create, change or delete them. A view only stores filters — what a person sees is still limited by
 * their role.
 */
import type { FastifyInstance } from 'fastify';
import { savedViewSchema, savedViewUpdateSchema, SAVED_VIEW_ENTITIES } from '@crm/shared';
import { q, q1, sql } from '../db/index.ts';
import type { Ctx } from '../lib/context.ts';
import { badRequest, forbidden, notFound } from '../lib/errors.ts';
import { ctxOf } from '../lib/http.ts';
import { requireAny } from '../lib/permissions.ts';
import { camel } from '../lib/records.ts';
import { parse } from '../lib/validate.ts';

const MAX_PER_USER = 50;
type ViewRow = { id: number; owner_id: number | null; entity_type: string; name: string; query: Record<string, string> };

const shape = (r: ViewRow) => ({ ...camel(r), shared: r.owner_id === null });

async function loadOwn(ctx: Ctx, id: number): Promise<ViewRow> {
  const v = await q1<ViewRow>(sql`SELECT * FROM saved_views WHERE id = ${id} AND workspace_id = ${ctx.workspaceId}
    AND (owner_id = ${ctx.userId} OR owner_id IS NULL)`);
  if (!v) throw notFound('View');
  if (v.owner_id === null && !ctx.isAdmin) throw forbidden('Only admins can change shared views');
  return v;
}

export async function viewRoutes(app: FastifyInstance) {
  app.get('/views', async (req) => {
    const ctx = ctxOf(req);
    const entity = (req.query as { entityType?: string }).entityType;
    if (!SAVED_VIEW_ENTITIES.includes(entity as never)) throw badRequest('Unknown list');
    const rows = await q<ViewRow>(sql`SELECT id, owner_id, entity_type, name, query, created_at FROM saved_views
      WHERE workspace_id = ${ctx.workspaceId} AND entity_type = ${entity} AND (owner_id = ${ctx.userId} OR owner_id IS NULL)
      ORDER BY owner_id IS NOT NULL, lower(name), id`);
    return { data: rows.map(shape), canShare: ctx.isAdmin };
  });

  app.post('/views', async (req, reply) => {
    const ctx = ctxOf(req);
    const body = parse(savedViewSchema, req.body);
    requireAny(ctx, body.entityType, 'view');
    if (body.shared && !ctx.isAdmin) throw forbidden('Only admins can share views with everyone');
    const count = await q1<{ n: number }>(sql`SELECT count(*)::int AS n FROM saved_views WHERE workspace_id = ${ctx.workspaceId}
      AND owner_id = ${ctx.userId} AND entity_type = ${body.entityType}`);
    if (!body.shared && (count?.n ?? 0) >= MAX_PER_USER) throw badRequest(`You can save up to ${MAX_PER_USER} views per list`);
    const row = await q1<ViewRow>(sql`INSERT INTO saved_views (workspace_id, owner_id, entity_type, name, query)
      VALUES (${ctx.workspaceId}, ${body.shared ? null : ctx.userId}, ${body.entityType}, ${body.name}, ${JSON.stringify(body.query)}::jsonb)
      RETURNING id, owner_id, entity_type, name, query, created_at`);
    return reply.code(201).send(shape(row!));
  });

  app.patch<{ Params: { id: string } }>('/views/:id', async (req) => {
    const ctx = ctxOf(req);
    const body = parse(savedViewUpdateSchema, req.body);
    const v = await loadOwn(ctx, Number(req.params.id));
    if (body.shared !== undefined && body.shared !== (v.owner_id === null) && !ctx.isAdmin) throw forbidden('Only admins can share views with everyone');
    const owner = body.shared === undefined ? v.owner_id : body.shared ? null : ctx.userId;
    const row = await q1<ViewRow>(sql`UPDATE saved_views SET name = ${body.name ?? v.name},
      query = ${JSON.stringify(body.query ?? v.query)}::jsonb, owner_id = ${owner}
      WHERE id = ${v.id} AND workspace_id = ${ctx.workspaceId} RETURNING id, owner_id, entity_type, name, query, created_at`);
    return shape(row!);
  });

  app.delete<{ Params: { id: string } }>('/views/:id', async (req, reply) => {
    const ctx = ctxOf(req);
    const v = await loadOwn(ctx, Number(req.params.id));
    await q(sql`DELETE FROM saved_views WHERE id = ${v.id} AND workspace_id = ${ctx.workspaceId}`);
    return reply.code(204).send();
  });
}
