/** Inbox: conversations from all channels, replies, assignment and links to contacts/leads. */
import type { FastifyInstance } from 'fastify';
import { contactCreateSchema, conversationListSchema, conversationUpdateSchema, messageCaptionSchema, messageCreateSchema } from '@crm/shared';
import { config } from '../config.ts';
import { pool, q, q1, sql, tx, type Db } from '../db/index.ts';
import { audit, diff } from '../lib/audit.ts';
import type { Ctx } from '../lib/context.ts';
import { AppError, badRequest, forbidden, notFound } from '../lib/errors.ts';
import { files, newStorageKey } from '../lib/files.ts';
import { scanBuffer } from '../lib/virusScan.ts';
import { cleanFileName, cleanType, sendStoredFile } from './attachments.ts';
import { ctxOf } from '../lib/http.ts';
import { feedCursorColumn, feedQuery, feedResult, feedWhere, likeTerm } from '../lib/list.ts';
import { canOnConversation, canOnRecord, conversationScopeWhere, requireAny, scopeOf, scopeWhere } from '../lib/permissions.ts';
import { assertMembers, camel, camelAll } from '../lib/records.ts';
import { parse } from '../lib/validate.ts';
import type { ServerResponse } from 'node:http';
import { enqueue } from '../automation/engine.ts';
import { notifyInbox, stopListening, subscribe } from '../inbox/events.ts';
import { preview } from '../inbox/store.ts';
import { createContact } from './parties.ts';

type IdParams = { Params: { id: string } };

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

/** A message's files as JSON (alias m = messages). */
export const messageFilesJson = sql`(SELECT coalesce(json_agg(json_build_object('id', f.id, 'fileName', f.file_name, 'contentType', f.content_type,
    'sizeBytes', f.size_bytes, 'status', f.status) ORDER BY f.id), '[]'::json) FROM message_files f WHERE f.message_id = m.id) AS files`;

/** After a reply (text or file): take an unassigned conversation, reopen it, mark it read, queue Telegram delivery. */
async function afterReply(db: Db, ctx: Ctx, c: ConvRow, messageId: number, previewText: string, needsSending: boolean) {
  await q(sql`UPDATE conversations SET last_message_at = now(), last_message_preview = ${preview(previewText)}, last_direction = 'out',
    status = 'open', unread = 0, assignee_id = coalesce(assignee_id, ${ctx.userId}) WHERE id = ${c.id}`, db);
  if (!c.assignee_id) await audit(db, ctx, 'conversation', c.id, 'assigned', { assignee_id: [null, ctx.userId], via: 'reply' });
  if (needsSending) await enqueue('inbox.send', { messageId }, new Date(), db);
  await notifyInbox(db, c.id);
}

export async function inboxRoutes(app: FastifyInstance) {
  // Raw file uploads (replies with a file) are only accepted by this plugin's routes.
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: config.files.maxBytes }, (_req, body, done) => done(null, body));

  /**
   * Server-sent events: "conversation N changed" for conversations the user may see (see inbox/events.ts). Streams
   * end after 30 minutes; the browser reconnects, which also picks up permission changes.
   */
  const streams = new Set<ServerResponse>();
  app.addHook('preClose', async () => { for (const s of streams) s.end(); streams.clear(); await stopListening(); });
  app.get('/inbox/events', async (req, reply) => {
    const ctx = ctxOf(req);
    requireAny(ctx, 'conversation', 'view');
    const res = reply.raw;
    const unsubscribe = await subscribe(ctx, (id) => { res.write(`event: conversation\ndata: {"conversationId":${id}}\n\n`); });
    reply.hijack();
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 5000\n\n: connected\n\n');
    streams.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    const expire = setTimeout(() => res.end(), 30 * 60_000);
    res.on('close', () => { clearInterval(ping); clearTimeout(expire); unsubscribe(); streams.delete(res); });
  });

  app.get('/inbox/conversations', async (req) => {
    const ctx = ctxOf(req);
    requireAny(ctx, 'conversation', 'view');
    const f = parse(conversationListSchema, req.query);
    const term = f.q ? likeTerm(f.q) : null;
    const feed = feedQuery(f);
    const rows = await q<{ id: number; feed_us: number }>(sql`
      SELECT cv.id, ${feedCursorColumn('cv.last_message_at')}, cv.channel_id, ch.kind AS channel_kind, ch.name AS channel_name, cv.kind, cv.title, cv.status, cv.unread,
        cv.last_message_at, cv.last_message_preview, cv.last_direction, cv.assignee_id, u.name AS assignee_name,
        cv.contact_id, cv.lead_id, ${linkedColumns(ctx)}
      FROM conversations cv JOIN channels ch ON ch.id = cv.channel_id LEFT JOIN users u ON u.id = cv.assignee_id ${linkedJoins}
      WHERE cv.workspace_id = ${ctx.workspaceId} AND ${conversationScopeWhere(ctx, 'view', 'cv')} ${f.status === 'all' ? sql`` : sql`AND cv.status = ${f.status}`}
        ${f.assignee === 'me' ? sql`AND cv.assignee_id = ${ctx.userId}` : f.assignee === 'unassigned' ? sql`AND cv.assignee_id IS NULL` : sql``}
        ${f.channelId ? sql`AND cv.channel_id = ${f.channelId}` : sql``}
        ${f.contactId ? sql`AND cv.contact_id = ${f.contactId}` : sql``}
        ${f.leadId ? sql`AND cv.lead_id = ${f.leadId}` : sql``}
        AND ${feedWhere(feed, 'cv.last_message_at', 'cv.id')}
        ${term ? sql`AND (cv.title ILIKE ${term} OR cv.profile->>'username' ILIKE ${term} OR cv.profile->>'email' ILIKE ${term}
                       OR EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = cv.id AND m.body ILIKE ${term}))` : sql``}
      ORDER BY cv.last_message_at DESC, cv.id DESC LIMIT ${feed.limit + 1}`);
    const page = feedResult(rows, feed);
    return { data: camelAll(page.data as Record<string, unknown>[]), nextCursor: page.nextCursor };
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
        SELECT m.id, m.direction, m.sender_name, m.author_id, a.name AS author_name, m.body, m.status, m.error, m.created_at,
          ${messageFilesJson}
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
    await notifyInbox(pool, c.id);
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
      await afterReply(db, ctx, c, m!.id, body.body, status === 'pending');
      return m!;
    });
    return reply.code(201).send(out);
  });

  /** Reply with a file: raw bytes (application/octet-stream), ?fileName=&caption=, X-File-Type = the file's type. */
  app.post<IdParams & { Querystring: { fileName?: string; caption?: string } }>('/inbox/conversations/:id/files',
    { bodyLimit: config.files.maxBytes, config: { rateLimit: { max: config.isTest ? 1000 : 60, timeWindow: '1 minute' } } }, async (req, reply) => {
      const ctx = ctxOf(req);
      requireAny(ctx, 'conversation', 'edit');
      if (!Buffer.isBuffer(req.body)) throw new AppError(415, 'UNSUPPORTED', 'Upload the file as application/octet-stream');
      const data = req.body as Buffer;
      if (data.length === 0) throw badRequest('The file is empty');
      const fileName = cleanFileName(String(req.query.fileName ?? ''));
      const contentType = cleanType(req.headers['x-file-type']);
      const caption = parse(messageCaptionSchema, { caption: req.query.caption ?? '' }).caption;
      const c0 = await loadConversation(pool, ctx, Number(req.params.id), 'edit'); // permission before scanning
      if (c0.channel_status !== 'active') throw new AppError(409, 'CHANNEL_INACTIVE', 'This channel is disabled or disconnected, so replies can’t be sent.');
      if (config.files.clamav.host) {
        let verdict;
        try { verdict = await scanBuffer(data, config.files.clamav); } catch {
          throw new AppError(503, 'SCANNER_UNAVAILABLE', 'Files can’t be checked for viruses right now, so the file was not sent. Please try again later.');
        }
        if (!verdict.clean) throw new AppError(422, 'FILE_INFECTED', `“${fileName}” was flagged by the virus scanner (${verdict.signature}) and was not sent.`);
      }
      const key = newStorageKey(ctx.workspaceId);
      const out = await tx(async (db) => {
        const c = await loadConversation(db, ctx, c0.id, 'edit', true);
        const status = c.channel_kind === 'webchat' ? 'sent' : 'pending';
        const m = await q1<{ id: number }>(sql`INSERT INTO messages (workspace_id, conversation_id, direction, sender_name, author_id, body, status)
          VALUES (${ctx.workspaceId}, ${c.id}, 'out', ${ctx.userName}, ${ctx.userId}, ${caption}, ${status}) RETURNING id`, db);
        await q(sql`INSERT INTO message_files (workspace_id, message_id, file_name, content_type, size_bytes, status, storage_key)
          VALUES (${ctx.workspaceId}, ${m!.id}, ${fileName}, ${contentType}, ${data.length}, 'stored', ${key})`, db);
        await afterReply(db, ctx, c, m!.id, `📎 ${fileName}${caption ? ` ${caption}` : ''}`, status === 'pending');
        await files().put(key, data); // inside the transaction: if storage fails, nothing is recorded
        return m!;
      });
      return reply.code(201).send(out);
    });

  app.get<{ Params: { id: string }; Querystring: { inline?: string } }>('/inbox/files/:id', async (req, reply) => {
    const ctx = ctxOf(req);
    requireAny(ctx, 'conversation', 'view');
    const f = await q1<{ file_name: string; content_type: string; storage_key: string | null; status: string; conversation_id: number }>(sql`
      SELECT f.file_name, f.content_type, f.storage_key, f.status, m.conversation_id FROM message_files f JOIN messages m ON m.id = f.message_id
      WHERE f.id = ${Number(req.params.id) || 0} AND f.workspace_id = ${ctx.workspaceId}`);
    if (!f) throw notFound('File');
    await loadConversation(pool, ctx, f.conversation_id, 'view');
    const data = f.status === 'stored' && f.storage_key ? await files().get(f.storage_key) : null;
    if (!data) throw notFound('File content');
    return sendStoredFile(reply, f, data, req.query.inline === '1');
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
      await notifyInbox(db, c.id);
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
      await notifyInbox(db, c.id);
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
      await notifyInbox(db, c.id);
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
