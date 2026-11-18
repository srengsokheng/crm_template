/**
 * A contact's broadcast status (the "Broadcasts" card on the contact page): whether they get broadcast emails, which
 * of their Telegram/WhatsApp chats opted out (STOP), and the latest broadcasts they received. Team members who may
 * edit the contact can record an opt-out the customer asked for, or undo one at the customer's request.
 */
import type { FastifyInstance } from 'fastify';
import { contactChatOptOutSchema, contactEmailOptOutSchema } from '@crm/shared';
import { pool, q, q1, sql, tx } from '../db/index.ts';
import { audit } from '../lib/audit.ts';
import type { Ctx } from '../lib/context.ts';
import { forbidden, notFound } from '../lib/errors.ts';
import { ctxOf } from '../lib/http.ts';
import { assertOnRecord, canOnConversation, canOnRecord, conversationScopeWhere } from '../lib/permissions.ts';
import { camel, camelAll, getActive } from '../lib/records.ts';
import { parse } from '../lib/validate.ts';
import { setEmailOptOut } from './broadcasts.ts';
import type { Db } from '../db/index.ts';

interface ContactRow { id: number; owner_id: number; visibility: string; email_opt_out_at: string | null }

async function loadContact(db: Db, ctx: Ctx, id: number, action: 'view' | 'edit'): Promise<ContactRow> {
  const c = await getActive<ContactRow>(db, 'contacts', id, ctx, 'Contact');
  assertOnRecord(ctx, 'contact', action, c);
  return c;
}

const hasConversations = (ctx: Ctx) => ctx.isAdmin || (ctx.grants.conversation?.view ?? 'none') !== 'none';

export async function contactMarketingRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>('/contacts/:id/marketing', async (req) => {
    const ctx = ctxOf(req);
    const c = await loadContact(pool, ctx, Number(req.params.id), 'view');
    const emails = await q<{ value: string }>(sql`SELECT value FROM contact_methods
      WHERE workspace_id = ${ctx.workspaceId} AND party_type = 'contact' AND party_id = ${c.id} AND kind = 'email' ORDER BY is_primary DESC, sort, id`);
    // Chats only for people who may see those conversations.
    const chats = hasConversations(ctx) ? await q<{ id: number; assignee_id: number | null }>(sql`
      SELECT cv.id, cv.assignee_id, ch.kind AS channel_kind, ch.name AS channel_name, cv.title, cv.opted_out_at
      FROM conversations cv JOIN channels ch ON ch.id = cv.channel_id
      WHERE cv.workspace_id = ${ctx.workspaceId} AND cv.contact_id = ${c.id} AND cv.kind = 'direct'
        AND ch.kind IN ('telegram_bot', 'whatsapp') AND ${conversationScopeWhere(ctx, 'view', 'cv')}
      ORDER BY cv.last_message_at DESC LIMIT 20`) : [];
    const received = await q(sql`SELECT b.id AS broadcast_id, b.name, b.channel_kind, r.sent_at,
        CASE WHEN m.status = 'failed' OR r.status = 'failed' THEN 'failed' WHEN m.status = 'pending' OR r.status = 'pending' THEN 'sending'
             WHEN r.status = 'skipped' THEN 'skipped' ELSE 'sent' END AS status
      FROM broadcast_recipients r JOIN broadcasts b ON b.id = r.broadcast_id LEFT JOIN messages m ON m.id = r.message_id
      WHERE b.workspace_id = ${ctx.workspaceId} AND (r.contact_id = ${c.id}
        OR r.conversation_id IN (SELECT id FROM conversations WHERE contact_id = ${c.id} AND workspace_id = ${ctx.workspaceId}))
      ORDER BY r.id DESC LIMIT 10`);
    const canEdit = canOnRecord(ctx, 'contact', 'edit', c);
    return {
      canEdit,
      email: { addresses: emails.map((e) => e.value), optedOutAt: c.email_opt_out_at },
      chats: camelAll(chats.map(({ assignee_id, ...rest }) => ({ ...rest, can_edit: canEdit && canOnConversation(ctx, 'edit', { assignee_id }) }))),
      received: camelAll(received),
    };
  });

  /** The customer asked (by phone, in person…) to stop or restart broadcast emails: covers every contact with their address. */
  app.post<{ Params: { id: string } }>('/contacts/:id/email-opt-out', async (req) => {
    const ctx = ctxOf(req);
    const body = parse(contactEmailOptOutSchema, req.body);
    await tx(async (db) => {
      const c = await loadContact(db, ctx, Number(req.params.id), 'edit');
      const emails = await q<{ normalized: string }>(sql`SELECT normalized FROM contact_methods
        WHERE workspace_id = ${ctx.workspaceId} AND party_type = 'contact' AND party_id = ${c.id} AND kind = 'email'`, db);
      const changed = await setEmailOptOut(db, ctx, emails.map((e) => e.normalized), body.optedOut, 'team');
      // A contact without an email address still keeps the choice (it applies once an address is added).
      if (!changed.includes(c.id) && (c.email_opt_out_at === null) === body.optedOut) {
        await q(sql`UPDATE contacts SET email_opt_out_at = ${body.optedOut ? sql`now()` : null} WHERE id = ${c.id}`, db);
        await audit(db, ctx, 'contact', c.id, body.optedOut ? 'email_unsubscribed' : 'email_resubscribed', { via: 'team' });
      }
    });
    return { ok: true };
  });

  /** The same for one Telegram/WhatsApp chat of the contact. */
  app.post<{ Params: { id: string } }>('/contacts/:id/chat-opt-out', async (req) => {
    const ctx = ctxOf(req);
    const body = parse(contactChatOptOutSchema, req.body);
    await tx(async (db) => {
      const c = await loadContact(db, ctx, Number(req.params.id), 'edit');
      const cv = await q1<{ id: number; assignee_id: number | null; opted_out_at: string | null; channel_kind: string; channel_name: string }>(sql`
        SELECT cv.id, cv.assignee_id, cv.opted_out_at, ch.kind AS channel_kind, ch.name AS channel_name
        FROM conversations cv JOIN channels ch ON ch.id = cv.channel_id
        WHERE cv.id = ${body.conversationId} AND cv.workspace_id = ${ctx.workspaceId} AND cv.contact_id = ${c.id} FOR UPDATE OF cv`, db);
      if (!cv || !hasConversations(ctx) || !canOnConversation(ctx, 'view', cv)) throw notFound('Conversation');
      if (!canOnConversation(ctx, 'edit', cv)) throw forbidden('You can read this conversation but not change it');
      if ((cv.opted_out_at !== null) === body.optedOut) return;
      await q(sql`UPDATE conversations SET opted_out_at = ${body.optedOut ? sql`now()` : null} WHERE id = ${cv.id}`, db);
      await audit(db, ctx, 'contact', c.id, body.optedOut ? 'chat_opted_out' : 'chat_opted_in',
        { channel: cv.channel_kind, channelName: cv.channel_name, conversationId: cv.id, via: 'team' });
    });
    return camel({ ok: true });
  });
}
