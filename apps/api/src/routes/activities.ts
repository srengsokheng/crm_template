import type { FastifyInstance } from 'fastify';
import { activityCreateSchema, activityUpdateSchema, listQuerySchema, noteCreateSchema, noteUpdateSchema, type RecordType } from '@crm/shared';
import { join, pool, q, q1, raw, sql, tx, type Db } from '../db/index.ts';
import { audit } from '../lib/audit.ts';
import type { Ctx } from '../lib/context.ts';
import { badRequest, forbidden, notFound } from '../lib/errors.ts';
import { ctxOf } from '../lib/http.ts';
import { feedCursorColumn, feedQuery, feedResult, feedWhere, likeTerm, qs, runList } from '../lib/list.ts';
import { assertOnRecord, pipelineAllowed, requireAny, scopeOf, scopeWhere } from '../lib/permissions.ts';
import { assertMembers, camel, camelAll } from '../lib/records.ts';
import { redactChanges } from '../lib/fieldAccess.ts';
import { parse } from '../lib/validate.ts';

type IdParams = { Params: { id: string } };
const TABLE: Record<RecordType, string> = { lead: 'leads', deal: 'deals', contact: 'contacts', company: 'companies' };

/** Load a linked record and check the caller may view it. */
export async function loadRecordForView(db: Db, ctx: Ctx, type: RecordType, id: number) {
  const row = await q1<{ id: number; owner_id: number; visibility: string }>(
    sql`SELECT id, owner_id, visibility${type === 'deal' || type === 'lead' ? sql`, pipeline_id` : sql``} FROM ${raw(TABLE[type])}
      WHERE id = ${id} AND workspace_id = ${ctx.workspaceId} AND deleted_at IS NULL`, db);
  if (!row) throw notFound(type[0].toUpperCase() + type.slice(1));
  assertOnRecord(ctx, type, 'view', row);
  return row;
}

/** Activity columns plus its links; titles of deals/leads in pipelines the user can't access are hidden. */
const activitySelect = (ctx: Ctx) => sql`a.id, a.kind, a.subject, a.description, a.due_at, a.duration_minutes, a.priority, a.assignee_id, a.status,
  a.completed_at, a.reminder_at, a.direction, a.outcome, a.location, a.created_by, a.created_at, a.updated_at, u.name AS assignee_name,
  coalesce((SELECT json_agg(json_build_object('entityType', al.entity_type, 'entityId', al.entity_id,
    'title', CASE al.entity_type
      WHEN 'deal' THEN (SELECT CASE WHEN pipeline_id = ANY(${ctx.blockedPipelineIds}) THEN 'Restricted deal' ELSE title END FROM deals WHERE id = al.entity_id)
      WHEN 'lead' THEN (SELECT CASE WHEN pipeline_id = ANY(${ctx.blockedPipelineIds}) THEN 'Restricted lead' ELSE title END FROM leads WHERE id = al.entity_id)
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
  const row = await q1(sql`SELECT ${activitySelect(ctx)} FROM activities a LEFT JOIN users u ON u.id = a.assignee_id
    WHERE a.id = ${id} AND a.workspace_id = ${ctx.workspaceId} AND a.deleted_at IS NULL`, db);
  if (!row) throw notFound('Activity');
  return camel(row);
}

export function canTouchActivity(ctx: Ctx, action: 'view' | 'edit' | 'delete', row: { assignee_id: number | null; created_by: number | null }) {
  if (ctx.isAdmin) return true;
  const s = scopeOf(ctx, 'activity', action);
  const people = [row.assignee_id, row.created_by].filter((x): x is number => x !== null);
  if (s === 'all') return true;
  if (s === 'team') return people.some((p) => ctx.teamUserIds.includes(p));
  if (s === 'own') return people.includes(ctx.userId);
  return false;
}

/** Hidden custom field values never appear in history; an update that only touched hidden fields is left out. */
function redactEvents<T extends Record<string, unknown>>(ctx: Ctx, events: T[]): T[] {
  return events.flatMap((e) => {
    const before = e.changes;
    const changes = redactChanges(ctx, String(e.entityType), before);
    if (changes !== before && e.action === 'updated' && changes && !Object.keys(changes as object).length) return [];
    return [{ ...e, changes }];
  });
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
      select: activitySelect(ctx),
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
  /**
   * The record's history, newest first, paged with "Load more": notes, finished activities and changes merged into one
   * stream. Query: kind=all|note|activity|event, limit (default 30, max 100), before (cursor from nextCursor). The cursor
   * is (microseconds, source, id) so the three sources interleave exactly. "upcoming" (open activities) comes with the
   * first page only.
   */
  app.get<{ Params: { type: string; id: string }; Querystring: { kind?: string; limit?: string; before?: string } }>('/timeline/:type/:id', async (req) => {
    const ctx = ctxOf(req);
    const kind = (['note', 'activity', 'event'] as const).find((k) => k === req.query.kind) ?? 'all';
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
    let cursor: { us: number; src: number; id: number } | null = null;
    if (req.query.before) {
      const m = /^(-?\d{1,17})\|([123])\|(\d{1,15})$/.exec(Buffer.from(String(req.query.before), 'base64url').toString('utf8'));
      if (!m) throw badRequest('Invalid cursor');
      cursor = { us: Number(m[1]), src: Number(m[2]), id: Number(m[3]) };
    }
    const type = req.params.type as RecordType;
    if (!TABLE[type]) throw badRequest('Unknown record type');
    const id = Number(req.params.id);
    await loadRecordForView(pool, ctx, type, id);
    // Related records whose history also shows here (customer 360°).
    const related: { type: string; id: number }[] = [{ type, id }];
    if (type === 'contact') {
      for (const r of await q<{ id: number }>(sql`SELECT dc.deal_id AS id FROM deal_contacts dc JOIN deals d ON d.id = dc.deal_id
          WHERE dc.contact_id = ${id} AND ${pipelineAllowed(ctx, 'd')}`)) related.push({ type: 'deal', id: r.id });
      for (const r of await q<{ id: number }>(sql`SELECT l.id FROM leads l WHERE l.converted_contact_id = ${id} AND ${pipelineAllowed(ctx, 'l')}`)) related.push({ type: 'lead', id: r.id });
    } else if (type === 'company') {
      for (const r of await q<{ id: number }>(sql`SELECT d.id FROM deals d WHERE d.company_id = ${id} AND d.deleted_at IS NULL AND ${pipelineAllowed(ctx, 'd')}`)) related.push({ type: 'deal', id: r.id });
      for (const r of await q<{ id: number }>(sql`SELECT l.id FROM leads l WHERE l.converted_company_id = ${id} AND ${pipelineAllowed(ctx, 'l')}`)) related.push({ type: 'lead', id: r.id });
    } else if (type === 'deal') {
      const lead = await q1<{ lead_id: number | null }>(sql`SELECT d.lead_id FROM deals d JOIN leads l ON l.id = d.lead_id WHERE d.id = ${id} AND ${pipelineAllowed(ctx, 'l')}`);
      if (lead?.lead_id) related.push({ type: 'lead', id: lead.lead_id });
    }
    const relTypes = related.map((r) => r.type);
    const relIds = related.map((r) => r.id);
    const relMatch = (alias: string) => sql`(${raw(alias)}.entity_type, ${raw(alias)}.entity_id) IN (SELECT * FROM unnest(${relTypes}::text[], ${relIds}::bigint[]))`;

    // One query per source: rows after the cursor, newest first, limit + 1 each; merged below.
    const us = (expr: string) => raw(`(extract(epoch from ${expr}) * 1000000)::bigint`);
    const after = (expr: string, src: number, idCol: string) => cursor
      ? sql`AND (${us(expr)}, ${src}::int, ${raw(idCol)}) < (${cursor.us}::bigint, ${cursor.src}::int, ${cursor.id}::bigint)` : sql``;
    const none = Promise.resolve([] as Record<string, unknown>[]);
    const [notes, activities, events, upcoming] = await Promise.all([
      kind === 'all' || kind === 'note' ? q(sql`SELECT n.id, ${us('n.created_at')} AS feed_us, n.entity_type, n.entity_id, n.body, n.is_pinned, n.author_type, n.author_id, n.created_at, n.updated_at, u.name AS author_name
            FROM notes n LEFT JOIN users u ON u.id = n.author_id WHERE ${relMatch('n')} AND n.deleted_at IS NULL ${after('n.created_at', 1, 'n.id')}
            ORDER BY n.created_at DESC, n.id DESC LIMIT ${limit + 1}`) : none,
      kind === 'all' || kind === 'activity' ? q(sql`SELECT ${activitySelect(ctx)}, ${us('coalesce(a.completed_at, a.updated_at)')} AS feed_us FROM activities a LEFT JOIN users u ON u.id = a.assignee_id
            WHERE a.deleted_at IS NULL AND a.status <> 'open' AND EXISTS (SELECT 1 FROM activity_links al WHERE al.activity_id = a.id AND ${relMatch('al')})
              ${after('coalesce(a.completed_at, a.updated_at)', 2, 'a.id')}
            ORDER BY coalesce(a.completed_at, a.updated_at) DESC, a.id DESC LIMIT ${limit + 1}`) : none,
      kind === 'all' || kind === 'event' ? q(sql`SELECT e.id, ${us('e.created_at')} AS feed_us, e.entity_type, e.entity_id, e.action, e.changes, e.actor_type, e.actor_id, e.created_at, u.name AS actor_name,
              -- Events from related records name that record, but only when the user may see it.
              CASE WHEN rd.id IS NOT NULL AND ${scopeWhere(ctx, 'deal', 'view', 'rd')} THEN rd.title
                   WHEN rl.id IS NOT NULL AND ${scopeWhere(ctx, 'lead', 'view', 'rl')} THEN rl.title END AS entity_title
            FROM audit_events e LEFT JOIN users u ON u.id = e.actor_id
              LEFT JOIN deals rd ON e.entity_type = 'deal' AND rd.id = e.entity_id AND rd.workspace_id = e.workspace_id
              LEFT JOIN leads rl ON e.entity_type = 'lead' AND rl.id = e.entity_id AND rl.workspace_id = e.workspace_id
            WHERE e.workspace_id = ${ctx.workspaceId} AND ${relMatch('e')}
              AND (e.entity_type = ${type} AND e.entity_id = ${id} OR e.action IN ('created','won','lost','converted','disqualified'))
              AND e.action NOT LIKE 'activity\\_%' ${after('e.created_at', 3, 'e.id')}
            ORDER BY e.created_at DESC, e.id DESC LIMIT ${limit + 1}`) : none,
      cursor ? none : q(sql`SELECT ${activitySelect(ctx)} FROM activities a LEFT JOIN users u ON u.id = a.assignee_id
            WHERE a.deleted_at IS NULL AND a.status = 'open' AND EXISTS (SELECT 1 FROM activity_links al WHERE al.activity_id = a.id AND al.entity_type = ${type} AND al.entity_id = ${id})
            ORDER BY a.due_at NULLS LAST, a.id LIMIT 100`),
    ]);
    type Row = Record<string, unknown> & { id: number; feed_us: number };
    const tag = (rows: Record<string, unknown>[], src: number, t: string) => (rows as Row[]).map((r) => ({ src, t, r }));
    const merged = [...tag(notes, 1, 'note'), ...tag(activities, 2, 'activity'), ...tag(events, 3, 'event')]
      .sort((a, b) => Number(b.r.feed_us) - Number(a.r.feed_us) || b.src - a.src || b.r.id - a.r.id);
    const page = merged.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor = merged.length > limit && last ? Buffer.from(`${last.r.feed_us}|${last.src}|${last.r.id}`).toString('base64url') : null;
    const strip = ({ feed_us: _f, ...rest }: Row) => { void _f; return rest; };
    const items = page.flatMap(({ t, r }) => {
      const data = camelAll([strip(r)])[0] as Record<string, unknown>;
      if (t === 'event') {
        const shown = redactEvents(ctx, [data]); // may hide a change the role can't see (field permissions)
        return shown.length ? [{ type: t, at: data.createdAt, data: shown[0] }] : [];
      }
      return [{ type: t, at: t === 'note' ? data.createdAt : data.completedAt ?? data.updatedAt, data }];
    });
    return { ...(cursor ? {} : { upcoming: camelAll(upcoming) }), items, nextCursor };
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
    return { data: redactEvents(ctx, camelAll(rows).map((r) => ({ ...r, entityType: type }))) };
  });

  // ─────────────── Notifications ───────────────
  /** Newest first, paged with "Load more" (limit, before); `unread` counts all unread ones. */
  app.get('/notifications', async (req) => {
    const ctx = ctxOf(req);
    const feed = feedQuery(req.query as Record<string, unknown>);
    const rows = await q<{ id: number; feed_us: number }>(sql`SELECT id, ${feedCursorColumn('created_at')}, kind, title, body, entity_type, entity_id, read_at, created_at FROM notifications
      WHERE user_id = ${ctx.userId} AND workspace_id = ${ctx.workspaceId} AND ${feedWhere(feed, 'created_at', 'id')}
      ORDER BY created_at DESC, id DESC LIMIT ${feed.limit + 1}`);
    const unread = await q1<{ n: number }>(sql`SELECT count(*)::int AS n FROM notifications WHERE user_id = ${ctx.userId} AND workspace_id = ${ctx.workspaceId} AND read_at IS NULL`);
    const page = feedResult(rows, feed);
    return { data: camelAll(page.data as Record<string, unknown>[]), nextCursor: page.nextCursor, unread: unread?.n ?? 0 };
  });
  app.post('/notifications/read', async (req) => {
    const ctx = ctxOf(req);
    const body = (req.body ?? {}) as { ids?: number[] };
    const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isInteger) : null;
    await q(sql`UPDATE notifications SET read_at = now() WHERE user_id = ${ctx.userId} AND read_at IS NULL ${ids ? sql`AND id = ANY(${ids})` : sql``}`);
    return { ok: true };
  });

}
