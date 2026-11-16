/** Inbox: conversations from all channels, replies, assignment and links to contacts/leads. */
import type { FastifyInstance } from 'fastify';
import { contactCreateSchema, conversationListSchema, conversationUpdateSchema, messageCreateSchema } from '@crm/shared';
import { pool, q, q1, sql, tx, type Db } from '../db/index.ts';
import { audit, diff } from '../lib/audit.ts';
import type { Ctx } from '../lib/context.ts';
import { AppError, forbidden, notFound } from '../lib/errors.ts';
import { ctxOf } from '../lib/http.ts';
import { likeTerm } from '../lib/list.ts';
import { canOnConversation, canOnRecord, conversationScopeWhere, requireAny, scopeOf, scopeWhere } from '../lib/permissions.ts';
import { assertMembers, camel, camelAll } from '../lib/records.ts';
import { parse } from '../lib/validate.ts';
import { enqueue } from '../automation/engine.ts';
import { preview } from '../inbox/store.ts';
import { createContact } from './parties.ts';

type IdParams = { Params: { id: string } };
const PAGE = 50;

interface ConvRow { id: number; workspace_id: number; channel_id: number; kind: 'direct' | 'group'; assignee_id: number | null; contact_id: number | null; lead_id: number | null; status: string; title: string; profile: Record<string, string | undefined>; channel_status: string; channel_kind: string }

async function loadConversation(db: Db, ctx: Ctx, id: number, action: 'view' | 'edit', lock = false): Promise<ConvRow> {
  const c = await q1<ConvRow>(sql`SELECT cv.*, ch.status AS channel_status, ch.kind AS channel_kind
    FROM conversations cv JOIN channels ch ON ch.id = cv.channel_id
    WHERE cv.id = ${id} AND cv.workspace_id = ${ctx.workspaceId} ${lock ? sql`FOR UPDATE OF cv` : sql``}`, db);
  // Conversations outside the user's view scope look like they don't exist.
  if (!c || !canOnConversation(ctx, 'view', c)) throw notFound('Conversation');
  if (action === 'edit' && !canOnConversation(ctx, 'edit', c)) throw forbidden('You can read this conversation but not reply to it or change it');
  return c;
}

/** Linked contact/lead names, only when the user may see that record. */
const linkedColumns = (ctx: Ctx) => sql`
  CASE WHEN ct.id IS NOT NULL AND ${scopeWhere(ctx, 'contact', 'view', 'ct')} THEN nullif(trim(concat_ws(' ', ct.first_name, ct.last_name)), '') END AS contact_name,
  CASE WHEN l.id IS NOT NULL AND ${scopeWhere(ctx, 'lead', 'view', 'l')} THEN l.title END AS lead_title`;
const linkedJoins = sql`
  LEFT JOIN contacts ct ON ct.id = cv.contact_id AND ct.deleted_at IS NULL
  LEFT JOIN leads l ON l.id = cv.lead_id AND l.deleted_at IS NULL`;

export async function inboxRoutes(app: FastifyInstance) {
  app.get('/inbox/conversations', async (req) => {
    const ctx = ctxOf(req);
    requireAny(ctx, 'conversation', 'view');
    const f = parse(conversationListSchema, req.query);
    const term = f.q ? likeTerm(f.q) : null;
    const rows = await q(sql`
      SELECT cv.id, cv.channel_id, ch.kind AS channel_kind, ch.name AS channel_name, cv.kind, cv.title, cv.status, cv.unread,
        cv.last_message_at, cv.last_message_preview, cv.last_direction, cv.assignee_id, u.name AS assignee_name,
        cv.contact_id, cv.lead_id, ${linkedColumns(ctx)}
      FROM conversations cv JOIN channels ch ON ch.id = cv.channel_id LEFT JOIN users u ON u.id = cv.assignee_id ${linkedJoins}
      WHERE cv.workspace_id = ${ctx.workspaceId} AND ${conversationScopeWhere(ctx, 'view', 'cv')} AND cv.status = ${f.status}
        ${f.assignee === 'me' ? sql`AND cv.assignee_id = ${ctx.userId}` : f.assignee === 'unassigned' ? sql`AND cv.assignee_id IS NULL` : sql``}
        ${f.channelId ? sql`AND cv.channel_id = ${f.channelId}` : sql``}
        ${f.contactId ? sql`AND cv.contact_id = ${f.contactId}` : sql``}
        ${f.leadId ? sql`AND cv.lead_id = ${f.leadId}` : sql``}
        ${f.before ? sql`AND cv.last_message_at < ${f.before}` : sql``}
        ${term ? sql`AND (cv.title ILIKE ${term} OR cv.profile->>'username' ILIKE ${term} OR cv.profile->>'email' ILIKE ${term}
                       OR EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = cv.id AND m.body ILIKE ${term}))` : sql``}
      ORDER BY cv.last_message_at DESC, cv.id DESC LIMIT ${PAGE + 1}`);
    return { data: camelAll(rows.slice(0, PAGE)), hasMore: rows.length > PAGE };
  });

  /** Counts for the sidebar badge: open conversations with unread messages that the user can see. */
  app.get('/inbox/summary', async (req) => {
    const ctx = ctxOf(req);
    if (scopeOf(ctx, 'conversation', 'view') === 'none') return { unread: 0, canView: false };
    const r = await q1<{ unread: number }>(sql`SELECT count(*)::int AS unread FROM conversations cv
      WHERE cv.workspace_id = ${ctx.workspaceId} AND cv.status = 'open' AND cv.unread > 0 AND ${conversationScopeWhere(ctx, 'view', 'cv')}`);
    return { unread: r!.unread, canView: true };
  });

  app.get<IdParams>('/inbox/conversations/:id', async (req) => {
    const ctx = ctxOf(req);
    requireAny(ctx, 'conversation', 'view');
    const c = await loadConversation(pool, ctx, Number(req.params.id), 'view');
    const row = await q1(sql`
      SELECT cv.id, cv.channel_id, ch.kind AS channel_kind, ch.name AS channel_name, ch.status AS channel_status, ch.config->>'username' AS bot_username,
        cv.kind, cv.title, cv.profile, cv.status, cv.unread, cv.assignee_id, u.name AS assignee_name, cv.contact_id, cv.lead_id,
        cv.created_at, ${linkedColumns(ctx)}
      FROM conversations cv JOIN channels ch ON ch.id = cv.channel_id LEFT JOIN users u ON u.id = cv.assignee_id ${linkedJoins}
      WHERE cv.id = ${c.id}`);
    // The latest 200 messages, oldest first.
    const messages = await q(sql`SELECT * FROM (
        SELECT m.id, m.direction, m.sender_name, m.author_id, a.name AS author_name, m.body, m.status, m.error, m.created_at
        FROM messages m LEFT JOIN users a ON a.id = m.author_id WHERE m.conversation_id = ${c.id} ORDER BY m.id DESC LIMIT 200
      ) t ORDER BY id`);
    return {
      ...camel(row!),
      canEdit: canOnConversation(ctx, 'edit', c),
      canReply: canOnConversation(ctx, 'edit', c) && c.channel_status === 'active',
      messages: camelAll(messages),
    };
  });

  app.post<IdParams>('/inbox/conversations/:id/read', async (req) => {
    const ctx = ctxOf(req);
    requireAny(ctx, 'conversation', 'view');
    const c = await loadConversation(pool, ctx, Number(req.params.id), 'view');
    await q(sql`UPDATE conversations SET unread = 0 WHERE id = ${c.id}`);
    await q(sql`UPDATE notifications SET read_at = now() WHERE user_id = ${ctx.userId} AND entity_type = 'conversation' AND entity_id = ${c.id} AND read_at IS NULL`);
    return { ok: true };
  });

  app.post<IdParams>('/inbox/conversations/:id/messages', async (req, reply) => {
    const ctx = ctxOf(req);
    requireAny(ctx, 'conversation', 'edit');
    const body = parse(messageCreateSchema, req.body);
    const out = await tx(async (db) => {
      const c = await loadConversation(db, ctx, Number(req.params.id), 'edit', true);
      if (c.channel_status !== 'active') throw new AppError(409, 'CHANNEL_INACTIVE', 'This channel is disabled or disconnected, so replies can’t be sent. An admin can reconnect it in Settings → Channels.');
      // Website chat replies are read by the visitor's widget straight from the database; Telegram replies are sent by a job.
      const status = c.channel_kind === 'webchat' ? 'sent' : 'pending';
      const m = await q1<{ id: number }>(sql`INSERT INTO messages (workspace_id, conversation_id, direction, sender_name, author_id, body, status)
        VALUES (${ctx.workspaceId}, ${c.id}, 'out', ${ctx.userName}, ${ctx.userId}, ${body.body}, ${status}) RETURNING id`, db);
      // Replying to an unassigned conversation takes it; replying reopens it and marks it read.
      await q(sql`UPDATE conversations SET last_message_at = now(), last_message_preview = ${preview(body.body)}, last_direction = 'out',
        status = 'open', unread = 0, assignee_id = coalesce(assignee_id, ${ctx.userId}) WHERE id = ${c.id}`, db);
      if (!c.assignee_id) await audit(db, ctx, 'conversation', c.id, 'assigned', { assignee_id: [null, ctx.userId], via: 'reply' });
      if (status === 'pending') await enqueue('inbox.send', { messageId: m!.id }, new Date(), db);
      return m!;
    });
    return reply.code(201).send(out);
  });

  /** Try a failed message again. */
  app.post<{ Params: { id: string; messageId: string } }>('/inbox/conversations/:id/messages/:messageId/retry', async (req) => {
    const ctx = ctxOf(req);
    requireAny(ctx, 'conversation', 'edit');
    return tx(async (db) => {
      const c = await loadConversation(db, ctx, Number(req.params.id), 'edit');
      if (c.channel_status !== 'active') throw new AppError(409, 'CHANNEL_INACTIVE', 'This channel is disabled or disconnected.');
      const m = await q1<{ id: number }>(sql`UPDATE messages SET status = 'pending', error = NULL
        WHERE id = ${Number(req.params.messageId)} AND conversation_id = ${c.id} AND direction = 'out' AND status = 'failed' RETURNING id`, db);
      if (!m) throw notFound('Failed message');
      await enqueue('inbox.send', { messageId: m.id }, new Date(), db);
      return { ok: true };
    });
  });

  app.patch<IdParams>('/inbox/conversations/:id', async (req) => {
    const ctx = ctxOf(req);
    requireAny(ctx, 'conversation', 'edit');
    const body = parse(conversationUpdateSchema, req.body);
    return tx(async (db) => {
      const c = await loadConversation(db, ctx, Number(req.params.id), 'edit', true);
      const next: Record<string, unknown> = {};
      if (body.status !== undefined) next.status = body.status;
      if (body.assigneeId !== undefined) {
        if (body.assigneeId !== null) await assertMembers(ctx, [body.assigneeId], db);
        next.assignee_id = body.assigneeId;
      }
      if (body.contactId !== undefined) {
        if (body.contactId !== null) await assertVisible(db, ctx, 'contact', body.contactId);
        next.contact_id = body.contactId;
      }
      if (body.leadId !== undefined) {
        if (body.leadId !== null) await assertVisible(db, ctx, 'lead', body.leadId);
        next.lead_id = body.leadId;
      }
      const changes = diff(c as unknown as Record<string, unknown>, next);
      if (!Object.keys(changes).length) return { ok: true };
      await q(sql`UPDATE conversations SET
        status = ${(next.status ?? c.status) as string}, assignee_id = ${('assignee_id' in next ? next.assignee_id : c.assignee_id) as number | null},
        contact_id = ${('contact_id' in next ? next.contact_id : c.contact_id) as number | null}, lead_id = ${('lead_id' in next ? next.lead_id : c.lead_id) as number | null}
        WHERE id = ${c.id}`, db);
      await audit(db, ctx, 'conversation', c.id, 'updated', changes);
      if (next.assignee_id && next.assignee_id !== ctx.userId) {
        await q(sql`INSERT INTO notifications (workspace_id, user_id, kind, title, body, entity_type, entity_id)
          VALUES (${ctx.workspaceId}, ${next.assignee_id as number}, 'assigned', ${`${ctx.userName} assigned you a conversation`}, ${c.title}, 'conversation', ${c.id})`, db);
      }
      return { ok: true };
    });
  });

  /** Creates a contact from what the conversation knows (name, email, phone, Telegram username) and links it. */
  app.post<IdParams>('/inbox/conversations/:id/contact', async (req, reply) => {
    const ctx = ctxOf(req);
    requireAny(ctx, 'conversation', 'edit');
    return tx(async (db) => {
      const c = await loadConversation(db, ctx, Number(req.params.id), 'edit', true);
      if (c.contact_id) throw new AppError(409, 'ALREADY_LINKED', 'This conversation is already linked to a contact');
      if (c.kind === 'group') throw new AppError(422, 'GROUP_CHAT', 'Group chats can be linked to an existing contact, but not turned into one');
      const p = c.profile ?? {};
      const name = (p.name || c.title).trim();
      const [first, ...rest] = name.split(/\s+/);
      const methods = [
        p.email ? { kind: 'email', value: p.email } : null,
        p.phone ? { kind: 'phone', value: p.phone } : null,
        p.username && c.channel_kind === 'telegram_bot' ? { kind: 'messenger', label: 'telegram', value: `@${p.username}` } : null,
      ].filter(Boolean);
      const input = parse(contactCreateSchema, { firstName: first || 'Unknown', lastName: rest.join(' ') || undefined, methods });
      const contact = await createContact(db, ctx, input, { via: 'inbox' });
      await q(sql`UPDATE conversations SET contact_id = ${contact.id} WHERE id = ${c.id}`, db);
      await audit(db, ctx, 'conversation', c.id, 'updated', { contact_id: [null, contact.id] });
      return reply.code(201).send({ id: contact.id });
    });
  });
}

async function assertVisible(db: Db, ctx: Ctx, entity: 'contact' | 'lead', id: number) {
  const row = await q1<{ owner_id: number | null; visibility: string; pipeline_id?: number | null }>(
    entity === 'contact'
      ? sql`SELECT owner_id, visibility FROM contacts WHERE id = ${id} AND workspace_id = ${ctx.workspaceId} AND deleted_at IS NULL`
      : sql`SELECT owner_id, visibility, pipeline_id FROM leads WHERE id = ${id} AND workspace_id = ${ctx.workspaceId} AND deleted_at IS NULL`, db);
  if (!row || !canOnRecord(ctx, entity, 'view', row)) throw new AppError(400, 'INVALID_REFERENCE', `${entity === 'contact' ? 'Contact' : 'Lead'} not found`);
}
