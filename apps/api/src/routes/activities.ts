import type { FastifyInstance } from 'fastify';
import { activityCreateSchema, activityUpdateSchema, listQuerySchema, noteCreateSchema, noteUpdateSchema, type RecordType } from '@crm/shared';
import { join, pool, q, q1, raw, sql, tx, type Db } from '../db/index.ts';
import { audit } from '../lib/audit.ts';
import type { Ctx } from '../lib/context.ts';
import { badRequest, forbidden, notFound } from '../lib/errors.ts';
import { ctxOf } from '../lib/http.ts';
import { likeTerm, qs, runList } from '../lib/list.ts';
import { assertOnRecord, requireAny, scopeOf, scopeWhere } from '../lib/permissions.ts';
import { assertMembers, camel, camelAll } from '../lib/records.ts';
import { parse } from '../lib/validate.ts';

type IdParams = { Params: { id: string } };
const TABLE: Record<RecordType, string> = { lead: 'leads', deal: 'deals', contact: 'contacts', company: 'companies' };

/** Load a linked record and check the caller may view it. */
export async function loadRecordForView(db: Db, ctx: Ctx, type: RecordType, id: number) {
  const row = await q1<{ id: number; owner_id: number; visibility: string }>(
    sql`SELECT id, owner_id, visibility FROM ${raw(TABLE[type])} WHERE id = ${id} AND workspace_id = ${ctx.workspaceId} AND deleted_at IS NULL`, db);
  if (!row) throw notFound(type[0].toUpperCase() + type.slice(1));
  assertOnRecord(ctx, type, 'view', row);
  return row;
}

const ACTIVITY_SELECT = sql`a.id, a.kind, a.subject, a.description, a.due_at, a.duration_minutes, a.priority, a.assignee_id, a.status,
  a.completed_at, a.reminder_at, a.direction, a.outcome, a.location, a.created_by, a.created_at, a.updated_at, u.name AS assignee_name,
  coalesce((SELECT json_agg(json_build_object('entityType', al.entity_type, 'entityId', al.entity_id,
    'title', CASE al.entity_type
      WHEN 'deal' THEN (SELECT title FROM deals WHERE id = al.entity_id)
      WHEN 'lead' THEN (SELECT title FROM leads WHERE id = al.entity_id)
      WHEN 'company' THEN (SELECT name FROM companies WHERE id = al.entity_id)
      ELSE (SELECT trim(coalesce(first_name,'') || ' ' || coalesce(last_name,'')) FROM contacts WHERE id = al.entity_id) END))
    FROM activity_links al WHERE al.activity_id = a.id), '[]') AS links`;

export async function createActivity(db: Db, ctx: Ctx, body: ReturnType<typeof activityCreateSchema.parse>, actorType: 'user' | 'automation' = 'user') {
  for (const l of body.links ?? []) await loadRecordForView(db, ctx, l.entityType, l.entityId);
  await assertMembers(ctx, [body.assigneeId], db);
  const due = body.dueAt ? new Date(body.dueAt) : null;
  const reminder = due && body.reminderMinutesBefore != null ? new Date(due.getTime() - body.reminderMinutesBefore * 60_000) : null;
  const done = body.status === 'done';
  const a = await q1<{ id: number }>(sql`INSERT INTO activities (workspace_id, kind, subject, description, due_at, duration_minutes, priority, assignee_id,
      status, completed_at, completed_by, reminder_at, direction, outcome, location, created_by)
    VALUES (${ctx.workspaceId}, ${body.kind}, ${body.subject}, ${body.description ?? null}, ${due}, ${body.durationMinutes ?? null},
      ${body.priority ?? 'normal'}, ${body.assigneeId ?? ctx.userId}, ${done ? 'done' : 'open'}, ${done ? new Date() : null}, ${done ? ctx.userId : null},
      ${reminder}, ${body.direction ?? null}, ${body.outcome ?? null}, ${body.location ?? null}, ${actorType === 'user' ? ctx.userId : null})
    RETURNING id`, db);
  for (const l of body.links ?? []) {
    await q(sql`INSERT INTO activity_links (activity_id, entity_type, entity_id) VALUES (${a!.id}, ${l.entityType}, ${l.entityId}) ON CONFLICT DO NOTHING`, db);
  }
  const assignee = body.assigneeId ?? ctx.userId;
  if (assignee !== ctx.userId || actorType === 'automation') {
    await q(sql`INSERT INTO notifications (workspace_id, user_id, kind, title, body, entity_type, entity_id)
      VALUES (${ctx.workspaceId}, ${assignee}, 'activity_assigned', ${'New ' + body.kind + ' assigned to you'}, ${body.subject}, 'activity', ${a!.id})`, db);
  }
  return a!.id;
}

export async function getActivity(db: Db, ctx: Ctx, id: number) {
  const row = await q1(sql`SELECT ${ACTIVITY_SELECT} FROM activities a LEFT JOIN users u ON u.id = a.assignee_id
    WHERE a.id = ${id} AND a.workspace_id = ${ctx.workspaceId} AND a.deleted_at IS NULL`, db);
  if (!row) throw notFound('Activity');
  return camel(row);
}

function canTouchActivity(ctx: Ctx, action: 'view' | 'edit' | 'delete', row: { assignee_id: number | null; created_by: number | null }) {
  if (ctx.isAdmin) return true;
  const s = scopeOf(ctx, 'activity', action);
  const people = [row.assignee_id, row.created_by].filter((x): x is number => x !== null);
  if (s === 'all') return true;
  if (s === 'team') return people.some((p) => ctx.teamUserIds.includes(p));
  if (s === 'own') return people.includes(ctx.userId);
  return false;
}

export async function activityRoutes(app: FastifyInstance) {
  // ─────────────── Activities ───────────────
  app.get('/activities', async (req) => {
    const ctx = ctxOf(req);
    requireAny(ctx, 'activity', 'view');
    const query = parse(listQuerySchema, req.query);
    const assignee = query.assigneeId === 'me' || query.assigneeId === undefined ? ctx.userId : qs.id(query.assigneeId);
    const bucket = qs.str(query.bucket); // overdue | today | upcoming | nodate | done
    const r = await runList({
      select: ACTIVITY_SELECT,
      from: sql`activities a LEFT JOIN users u ON u.id = a.assignee_id`,
      where: [
        sql`a.workspace_id = ${ctx.workspaceId}`, sql`a.deleted_at IS NULL`, scopeWhere(ctx, 'activity', 'view', 'a', 'assignee_id'),
        query.assigneeId === 'all' ? null : assignee ? sql`a.assignee_id = ${assignee}` : null,
        qs.str(query.kind) ? sql`a.kind = ${qs.str(query.kind)}` : null,
        bucket === 'done' ? sql`a.status = 'done'` : sql`a.status = 'open'`,
        bucket === 'overdue' ? sql`a.due_at < now()` : null,
        bucket === 'today' ? sql`a.due_at >= date_trunc('day', now()) AND a.due_at < date_trunc('day', now()) + interval '1 day'` : null,
        bucket === 'upcoming' ? sql`a.due_at >= date_trunc('day', now()) + interval '1 day'` : null,
        bucket === 'nodate' ? sql`a.due_at IS NULL` : null,
      ],
      search: (t) => sql`(a.subject ILIKE ${likeTerm(t)} OR a.description ILIKE ${likeTerm(t)})`,
      sorts: { dueAt: 'a.due_at', createdAt: 'a.created_at', completedAt: 'a.completed_at', subject: 'lower(a.subject)', priority: "array_position(ARRAY['high','normal','low'], a.priority)" },
      defaultSort: bucket === 'done' ? '-completedAt' : 'dueAt',
    }, query);
    return { ...r, data: camelAll(r.data as Record<string, unknown>[]) };
  });

  app.get('/activities/counts', async (req) => {
    const ctx = ctxOf(req);
    const row = await q1(sql`SELECT
      count(*) FILTER (WHERE due_at < now())::int AS overdue,
      count(*) FILTER (WHERE due_at >= date_trunc('day', now()) AND due_at < date_trunc('day', now()) + interval '1 day')::int AS today,
      count(*) FILTER (WHERE due_at >= date_trunc('day', now()) + interval '1 day')::int AS upcoming,
      count(*) FILTER (WHERE due_at IS NULL)::int AS nodate
      FROM activities WHERE workspace_id = ${ctx.workspaceId} AND assignee_id = ${ctx.userId} AND status = 'open' AND deleted_at IS NULL`);
    return row;
  });

  app.post('/activities', async (req, reply) => {
    const ctx = ctxOf(req);
    requireAny(ctx, 'activity', 'create');
    const body = parse(activityCreateSchema, req.body);
    const id = await tx(async (db) => {
      const aid = await createActivity(db, ctx, body);
      for (const l of body.links ?? []) await audit(db, ctx, l.entityType, l.entityId, 'activity_added', { activity: [null, body.subject] });
      return aid;
    });
    return reply.code(201).send(await getActivity(pool, ctx, id));
  });

  app.patch<IdParams>('/activities/:id', async (req) => {
    const ctx = ctxOf(req);
    const id = Number(req.params.id);
    const body = parse(activityUpdateSchema, req.body);
    return tx(async (db) => {
      const before = await q1<{ assignee_id: number | null; created_by: number | null; status: string; due_at: Date | null; reminder_at: Date | null }>(
        sql`SELECT assignee_id, created_by, status, due_at, reminder_at FROM activities WHERE id = ${id} AND workspace_id = ${ctx.workspaceId} AND deleted_at IS NULL`, db);
      if (!before) throw notFound('Activity');
      if (!canTouchActivity(ctx, 'edit', before)) throw forbidden();
      await assertMembers(ctx, [body.assigneeId], db);
      const sets: ReturnType<typeof sql>[] = [];
      const set = (col: string, v: unknown) => sets.push(sql`${raw(col)} = ${v}`);
      if (body.kind !== undefined) set('kind', body.kind);
      if (body.subject !== undefined) set('subject', body.subject);
      if (body.description !== undefined) set('description', body.description);
      if (body.dueAt !== undefined) { set('due_at', body.dueAt ? new Date(body.dueAt) : null); set('reminded_at', null); }
      if (body.durationMinutes !== undefined) set('duration_minutes', body.durationMinutes);
      if (body.priority !== undefined) set('priority', body.priority);
      if (body.assigneeId !== undefined) set('assignee_id', body.assigneeId);
      if (body.direction !== undefined) set('direction', body.direction);
      if (body.outcome !== undefined) set('outcome', body.outcome);
      if (body.location !== undefined) set('location', body.location);
      if (body.reminderMinutesBefore !== undefined) {
        const due = body.dueAt !== undefined ? (body.dueAt ? new Date(body.dueAt) : null) : before.due_at;
        set('reminder_at', due && body.reminderMinutesBefore != null ? new Date(due.getTime() - body.reminderMinutesBefore * 60_000) : null);
      }
      if (body.status !== undefined && body.status !== before.status) {
        set('status', body.status);
        set('completed_at', body.status === 'done' ? new Date() : null);
        set('completed_by', body.status === 'done' ? ctx.userId : null);
      }
      if (sets.length) {
        sets.push(sql`updated_at = now()`, sql`version = version + 1`);
        await q(sql`UPDATE activities SET ${join(sets)} WHERE id = ${id}`, db);
      }
      if (body.status && body.status !== before.status) {
        const links = await q<{ entity_type: string; entity_id: number }>(sql`SELECT entity_type, entity_id FROM activity_links WHERE activity_id = ${id}`, db);
        const subject = (await q1<{ subject: string }>(sql`SELECT subject FROM activities WHERE id = ${id}`, db))!.subject;
        for (const l of links) await audit(db, ctx, l.entity_type, l.entity_id, body.status === 'done' ? 'activity_completed' : 'activity_reopened', { activity: [null, subject] });
      }
      return getActivity(db, ctx, id);
    });
  });

  app.delete<IdParams>('/activities/:id', async (req, reply) => {
    const ctx = ctxOf(req);
    const id = Number(req.params.id);
    const row = await q1<{ assignee_id: number | null; created_by: number | null }>(sql`SELECT assignee_id, created_by FROM activities WHERE id = ${id} AND workspace_id = ${ctx.workspaceId} AND deleted_at IS NULL`);
    if (!row) throw notFound('Activity');
    if (!canTouchActivity(ctx, 'delete', row)) throw forbidden();
    await q(sql`UPDATE activities SET deleted_at = now() WHERE id = ${id}`);
    return reply.code(204).send();
  });

  // ─────────────── Notes ───────────────
  app.post('/notes', async (req, reply) => {
    const ctx = ctxOf(req);
    const body = parse(noteCreateSchema, req.body);
    await loadRecordForView(pool, ctx, body.entityType, body.entityId);
    const row = await q1(sql`INSERT INTO notes (workspace_id, entity_type, entity_id, body, is_pinned, author_id)
      VALUES (${ctx.workspaceId}, ${body.entityType}, ${body.entityId}, ${body.body}, ${body.isPinned ?? false}, ${ctx.userId}) RETURNING *`);
    return reply.code(201).send(camel(row));
  });

  app.patch<IdParams>('/notes/:id', async (req) => {
    const ctx = ctxOf(req);
    const body = parse(noteUpdateSchema, req.body);
    const note = await q1<{ author_id: number | null; entity_type: RecordType; entity_id: number }>(sql`SELECT author_id, entity_type, entity_id FROM notes
      WHERE id = ${Number(req.params.id)} AND workspace_id = ${ctx.workspaceId} AND deleted_at IS NULL`);
    if (!note) throw notFound('Note');
    await loadRecordForView(pool, ctx, note.entity_type, note.entity_id);
    if (body.body !== undefined && note.author_id !== ctx.userId && !ctx.isAdmin) throw forbidden('Only the author can edit this note');
    const row = await q1(sql`UPDATE notes SET body = coalesce(${body.body ?? null}, body), is_pinned = coalesce(${body.isPinned ?? null}, is_pinned), updated_at = now()
      WHERE id = ${Number(req.params.id)} RETURNING *`);
    return camel(row);
  });

  app.delete<IdParams>('/notes/:id', async (req, reply) => {
    const ctx = ctxOf(req);
    const note = await q1<{ author_id: number | null }>(sql`SELECT author_id FROM notes WHERE id = ${Number(req.params.id)} AND workspace_id = ${ctx.workspaceId} AND deleted_at IS NULL`);
    if (!note) throw notFound('Note');
    if (note.author_id !== ctx.userId && !ctx.isAdmin) throw forbidden('Only the author can delete this note');
    await q(sql`UPDATE notes SET deleted_at = now() WHERE id = ${Number(req.params.id)}`);
    return reply.code(204).send();
  });

  // ─────────────── Timeline ───────────────
  app.get<{ Params: { type: string; id: string } }>('/timeline/:type/:id', async (req) => {
    const ctx = ctxOf(req);
    const type = req.params.type as RecordType;
    if (!TABLE[type]) throw badRequest('Unknown record type');
    const id = Number(req.params.id);
    await loadRecordForView(pool, ctx, type, id);
    // Related records whose history also shows here (customer 360°).
    const related: { type: string; id: number }[] = [{ type, id }];
    if (type === 'contact') {
      for (const r of await q<{ id: number }>(sql`SELECT deal_id AS id FROM deal_contacts WHERE contact_id = ${id}`)) related.push({ type: 'deal', id: r.id });
      for (const r of await q<{ id: number }>(sql`SELECT id FROM leads WHERE converted_contact_id = ${id}`)) related.push({ type: 'lead', id: r.id });
    } else if (type === 'company') {
      for (const r of await q<{ id: number }>(sql`SELECT id FROM deals WHERE company_id = ${id} AND deleted_at IS NULL`)) related.push({ type: 'deal', id: r.id });
      for (const r of await q<{ id: number }>(sql`SELECT id FROM leads WHERE converted_company_id = ${id}`)) related.push({ type: 'lead', id: r.id });
    } else if (type === 'deal') {
      const lead = await q1<{ lead_id: number | null }>(sql`SELECT lead_id FROM deals WHERE id = ${id}`);
      if (lead?.lead_id) related.push({ type: 'lead', id: lead.lead_id });
    }
    const relTypes = related.map((r) => r.type);
    const relIds = related.map((r) => r.id);
    const relMatch = (alias: string) => sql`(${raw(alias)}.entity_type, ${raw(alias)}.entity_id) IN (SELECT * FROM unnest(${relTypes}::text[], ${relIds}::bigint[]))`;

    const [notes, activities, events, upcoming] = await Promise.all([
      q(sql`SELECT n.id, n.entity_type, n.entity_id, n.body, n.is_pinned, n.author_type, n.author_id, n.created_at, n.updated_at, u.name AS author_name
            FROM notes n LEFT JOIN users u ON u.id = n.author_id WHERE ${relMatch('n')} AND n.deleted_at IS NULL ORDER BY n.created_at DESC LIMIT 200`),
      q(sql`SELECT ${ACTIVITY_SELECT} FROM activities a LEFT JOIN users u ON u.id = a.assignee_id
            WHERE a.deleted_at IS NULL AND a.status <> 'open' AND EXISTS (SELECT 1 FROM activity_links al WHERE al.activity_id = a.id AND ${relMatch('al')})
            ORDER BY coalesce(a.completed_at, a.updated_at) DESC LIMIT 200`),
      q(sql`SELECT e.id, e.entity_type, e.entity_id, e.action, e.changes, e.actor_type, e.actor_id, e.created_at, u.name AS actor_name
            FROM audit_events e LEFT JOIN users u ON u.id = e.actor_id
            WHERE e.workspace_id = ${ctx.workspaceId} AND ${relMatch('e')}
              AND (e.entity_type = ${type} AND e.entity_id = ${id} OR e.action IN ('created','won','lost','converted','disqualified'))
            ORDER BY e.created_at DESC LIMIT 300`),
      q(sql`SELECT ${ACTIVITY_SELECT} FROM activities a LEFT JOIN users u ON u.id = a.assignee_id
            WHERE a.deleted_at IS NULL AND a.status = 'open' AND EXISTS (SELECT 1 FROM activity_links al WHERE al.activity_id = a.id AND al.entity_type = ${type} AND al.entity_id = ${id})
            ORDER BY a.due_at NULLS LAST, a.id`),
    ]);
    const items = [
      ...camelAll(notes).map((n) => ({ type: 'note', at: (n as { createdAt: Date }).createdAt, data: n })),
      ...camelAll(activities).map((a) => ({ type: 'activity', at: (a as { completedAt?: Date; updatedAt: Date }).completedAt ?? (a as { updatedAt: Date }).updatedAt, data: a })),
      ...camelAll(events).filter((e) => !String((e as { action: string }).action).startsWith('activity_')).map((e) => ({ type: 'event', at: (e as { createdAt: Date }).createdAt, data: e })),
    ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    return { upcoming: camelAll(upcoming), items };
  });

  // ─────────────── History (audit) ───────────────
  app.get<{ Params: { type: string; id: string } }>('/history/:type/:id', async (req) => {
    const ctx = ctxOf(req);
    const type = req.params.type as RecordType;
    if (!TABLE[type]) throw badRequest('Unknown record type');
    const id = Number(req.params.id);
    await loadRecordForView(pool, ctx, type, id);
    const rows = await q(sql`SELECT e.id, e.action, e.changes, e.actor_type, e.created_at, u.name AS actor_name FROM audit_events e
      LEFT JOIN users u ON u.id = e.actor_id WHERE e.workspace_id = ${ctx.workspaceId} AND e.entity_type = ${type} AND e.entity_id = ${id}
      ORDER BY e.created_at DESC, e.id DESC LIMIT 500`);
    return { data: camelAll(rows) };
  });

  // ─────────────── Notifications ───────────────
  app.get('/notifications', async (req) => {
    const ctx = ctxOf(req);
    const rows = await q(sql`SELECT id, kind, title, body, entity_type, entity_id, read_at, created_at FROM notifications
      WHERE user_id = ${ctx.userId} AND workspace_id = ${ctx.workspaceId} ORDER BY created_at DESC LIMIT 50`);
    const unread = await q1<{ n: number }>(sql`SELECT count(*)::int AS n FROM notifications WHERE user_id = ${ctx.userId} AND workspace_id = ${ctx.workspaceId} AND read_at IS NULL`);
    return { data: camelAll(rows), unread: unread?.n ?? 0 };
  });
  app.post('/notifications/read', async (req) => {
    const ctx = ctxOf(req);
    const body = (req.body ?? {}) as { ids?: number[] };
    const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isInteger) : null;
    await q(sql`UPDATE notifications SET read_at = now() WHERE user_id = ${ctx.userId} AND read_at IS NULL ${ids ? sql`AND id = ANY(${ids})` : sql``}`);
    return { ok: true };
  });

}
