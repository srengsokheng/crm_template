/**
 * Inbox saved replies. Personal ones are seen and changed only by their owner. Shared ones are seen by everyone who
 * can read the inbox; only admins share a reply or change a shared one. Creating needs the Inbox edit permission
 * (the people who reply).
 */
import type { FastifyInstance } from 'fastify';
import { savedReplySchema, savedReplyUpdateSchema } from '@crm/shared';
import { q, q1, sql } from '../db/index.ts';
import type { Ctx } from '../lib/context.ts';
import { forbidden, notFound } from '../lib/errors.ts';
import { ctxOf, noContent } from '../lib/http.ts';
import { requireAny } from '../lib/permissions.ts';
import { camel, camelAll } from '../lib/records.ts';
import { parse } from '../lib/validate.ts';

interface Row { id: number; owner_id: number; shared: boolean; title: string; body: string }

const canChange = (ctx: Ctx, r: Row) => r.owner_id === ctx.userId || (r.shared && ctx.isAdmin);

async function load(ctx: Ctx, id: number): Promise<Row> {
  const r = await q1<Row>(sql`SELECT id, owner_id, shared, title, body FROM saved_replies
    WHERE id = ${id} AND workspace_id = ${ctx.workspaceId} AND (shared OR owner_id = ${ctx.userId})`);
  if (!r) throw notFound('Saved reply'); // other people's personal replies don't exist for you
  if (!canChange(ctx, r)) throw forbidden('Only admins can change shared saved replies');
  return r;
}

export async function savedReplyRoutes(app: FastifyInstance) {
  app.get('/inbox/saved-replies', async (req) => {
    const ctx = ctxOf(req);
    requireAny(ctx, 'conversation', 'view');
    const rows = await q<Row & { owner_name: string }>(sql`SELECT r.id, r.owner_id, r.shared, r.title, r.body, u.name AS owner_name
      FROM saved_replies r JOIN users u ON u.id = r.owner_id
      WHERE r.workspace_id = ${ctx.workspaceId} AND (r.shared OR r.owner_id = ${ctx.userId})
      ORDER BY r.shared DESC, lower(r.title), r.id`);
    return { data: camelAll(rows.map((r) => ({ ...r, can_edit: canChange(ctx, r) }))) };
  });

  app.post('/inbox/saved-replies', async (req, reply) => {
    const ctx = ctxOf(req);
    requireAny(ctx, 'conversation', 'edit');
    const b = parse(savedReplySchema, req.body);
    if (b.shared && !ctx.isAdmin) throw forbidden('Only admins can share saved replies with the team');
    const r = await q1(sql`INSERT INTO saved_replies (workspace_id, owner_id, shared, title, body)
      VALUES (${ctx.workspaceId}, ${ctx.userId}, ${b.shared}, ${b.title}, ${b.body}) RETURNING id, owner_id, shared, title, body`);
    return reply.code(201).send(camel(r!));
  });

  app.patch<{ Params: { id: string } }>('/inbox/saved-replies/:id', async (req) => {
    const ctx = ctxOf(req);
    requireAny(ctx, 'conversation', 'edit');
    const b = parse(savedReplyUpdateSchema, req.body);
    const r = await load(ctx, Number(req.params.id) || 0);
    if (b.shared === true && !r.shared && !ctx.isAdmin) throw forbidden('Only admins can share saved replies with the team');
    const out = await q1(sql`UPDATE saved_replies SET title = ${b.title ?? r.title}, body = ${b.body ?? r.body}, shared = ${b.shared ?? r.shared},
      updated_at = now() WHERE id = ${r.id} RETURNING id, owner_id, shared, title, body`);
    return camel(out!);
  });

  app.delete<{ Params: { id: string } }>('/inbox/saved-replies/:id', async (req, reply) => {
    const ctx = ctxOf(req);
    requireAny(ctx, 'conversation', 'edit');
    const r = await load(ctx, Number(req.params.id) || 0);
    await q(sql`DELETE FROM saved_replies WHERE id = ${r.id}`);
    return noContent(reply);
  });
}
