/** Writing incoming messages into the Inbox, shared by all channels. */
import { q, q1, sql, type Db } from '../db/index.ts';
import { notifyInbox } from './events.ts';
import { ct, type CustomerLanguage } from '@crm/shared';
import { audit } from '../lib/audit.ts';
import { systemCtx } from '../lib/context.ts';

export interface ChannelRow {
  id: number; workspace_id: number; kind: 'webchat' | 'telegram_bot' | 'messenger' | 'instagram' | 'whatsapp' | 'telegram_user'; name: string; public_key: string;
  config: Record<string, unknown>; secret: string | null; webhook_secret: string | null; status: string; last_error?: string | null;
}

export interface Inbound {
  channel: ChannelRow;
  /** The chat on the platform (Telegram chat id, hashed website-chat token, Messenger/Instagram user id, WhatsApp number). */
  chatId: string;
  kind: 'direct' | 'group';
  /** Conversation title: the person's name, or the group's name. */
  title: string;
  profile: { name?: string; username?: string; email?: string; phone?: string; platformId?: string };
  /** The platform's message id (dedupes retries); null when the platform has none. */
  messageId: string | null;
  senderName: string;
  body: string;
}

/** First 140 characters (whole characters: emoji are never cut in half). */
export const preview = (body: string) => [...body.replace(/\s+/g, ' ').trim()].slice(0, 140).join('');

/**
 * Stores one incoming message: creates the conversation on first contact (linked to the contact with the same email
 * when there is exactly one), reopens closed conversations, counts it as unread and notifies the assignee.
 * Returns null when the message was already stored (platform retry).
 */
export async function recordInbound(db: Db, m: Inbound): Promise<{ conversationId: number; messageId: number } | null> {
  const ws = m.channel.workspace_id;
  let conv = await q1<{ id: number; assignee_id: number | null; status: string; profile: Record<string, unknown> }>(sql`
    SELECT id, assignee_id, status, profile FROM conversations WHERE channel_id = ${m.channel.id} AND external_id = ${m.chatId} FOR UPDATE`, db);
  if (!conv) {
    const contactId = m.profile.email ? await contactByEmail(db, ws, m.profile.email)
      : m.profile.phone ? await contactByPhone(db, ws, m.profile.phone) : null;
    conv = await q1(sql`
      INSERT INTO conversations (workspace_id, channel_id, external_id, kind, title, profile, contact_id)
      VALUES (${ws}, ${m.channel.id}, ${m.chatId}, ${m.kind}, ${m.title.slice(0, 200) || 'Unknown'}, ${JSON.stringify(m.profile)}, ${contactId})
      ON CONFLICT (channel_id, external_id) DO UPDATE SET title = conversations.title
      RETURNING id, assignee_id, status, profile`, db);
  }
  const c = conv!;
  const msg = await q1<{ id: number }>(sql`
    INSERT INTO messages (workspace_id, conversation_id, direction, external_id, sender_name, body, status)
    VALUES (${ws}, ${c.id}, 'in', ${m.messageId}, ${m.senderName.slice(0, 200)}, ${m.body}, 'received')
    ON CONFLICT (conversation_id, direction, external_id) DO NOTHING RETURNING id`, db);
  if (!msg) return null;
  // Keep what the platform/visitor told us up to date (a visitor may add their email in a later message).
  const profile = { ...c.profile, ...Object.fromEntries(Object.entries(m.profile).filter(([, v]) => v)) };
  await q(sql`
    UPDATE conversations SET unread = unread + 1, status = 'open', last_message_at = now(), last_message_preview = ${preview(m.body)},
      last_direction = 'in', profile = ${JSON.stringify(profile)}, title = CASE WHEN ${m.kind} = 'group' THEN ${m.title.slice(0, 200)} ELSE title END
    WHERE id = ${c.id}`, db);
  if (c.assignee_id) {
    // One unread notification per conversation is enough; it links to the conversation.
    await q(sql`
      INSERT INTO notifications (workspace_id, user_id, kind, title, body, entity_type, entity_id)
      SELECT ${ws}, ${c.assignee_id}, 'message', ${`New message from ${m.senderName || m.title}`}, ${preview(m.body)}, 'conversation', ${c.id}
      WHERE NOT EXISTS (SELECT 1 FROM notifications WHERE user_id = ${c.assignee_id} AND entity_type = 'conversation'
                        AND entity_id = ${c.id} AND read_at IS NULL)`, db);
  }
  if (m.kind === 'direct' && (m.channel.kind === 'telegram_bot' || m.channel.kind === 'whatsapp')) await optOutReply(db, m.channel, c.id, m.body);
  await notifyInbox(db, c.id);
  return { conversationId: c.id, messageId: msg.id };
}

/** Words that stop or restart broadcasts (a message that is only this word, any case; Telegram commands too). */
export const STOP_WORDS = ['stop', '/stop', 'unsubscribe', 'ឈប់'];
export const START_WORDS = ['start', '/start', 'subscribe'];
const keyword = (body: string) => body.trim().toLowerCase().replace(/[.!។]+$/u, '');

/**
 * Broadcast opt-out: "STOP" marks the chat as opted out (no broadcast reaches it again), "START" undoes it. When the
 * state changes, the customer gets a confirmation in the workspace's customer language. Normal replies still work.
 */
async function optOutReply(db: Db, ch: ChannelRow, conversationId: number, body: string): Promise<void> {
  const k = keyword(body);
  const stop = STOP_WORDS.includes(k);
  if (!stop && !START_WORDS.includes(k)) return;
  const changed = await q1<{ id: number; contact_id: number | null }>(sql`UPDATE conversations SET opted_out_at = ${stop ? sql`now()` : null}
    WHERE id = ${conversationId} AND (opted_out_at IS NULL) = ${stop} RETURNING id, contact_id`, db);
  if (!changed) return;
  if (changed.contact_id) {
    await audit(db, systemCtx(ch.workspace_id, 0), 'contact', changed.contact_id, stop ? 'chat_opted_out' : 'chat_opted_in',
      { channel: ch.kind, channelName: ch.name, conversationId, via: 'customer' }, 'system');
  }
  const ws = await q1<{ name: string; lang: string | null }>(sql`SELECT name, settings->'documents'->>'customerLanguage' AS lang FROM workspaces WHERE id = ${ch.workspace_id}`, db);
  const lang = (['en', 'km', 'both'].includes(ws?.lang ?? '') ? ws!.lang : 'en') as CustomerLanguage;
  const text = ct(lang, stop ? 'optOutDone' : 'optInDone', { company: ws?.name ?? '' });
  const out = await q1<{ id: number }>(sql`INSERT INTO messages (workspace_id, conversation_id, direction, sender_name, body, status)
    VALUES (${ch.workspace_id}, ${conversationId}, 'out', ${ws?.name ?? ''}, ${text}, 'pending') RETURNING id`, db);
  await q(sql`INSERT INTO jobs (type, payload) VALUES ('inbox.send', ${JSON.stringify({ messageId: out!.id })})`, db);
}

/** The one contact with this phone number (as +country… or the same digits without +); null if none or several. */
async function contactByPhone(db: Db, workspaceId: number, phone: string): Promise<number | null> {
  const digits = phone.replace(/[^\d]/g, '');
  if (digits.length < 6) return null;
  const rows = await q<{ id: number }>(sql`
    SELECT DISTINCT c.id FROM contact_methods m JOIN contacts c ON c.id = m.party_id
    WHERE m.workspace_id = ${workspaceId} AND m.party_type = 'contact' AND m.kind = 'phone' AND m.normalized IN (${'+' + digits}, ${digits})
      AND c.deleted_at IS NULL LIMIT 2`, db);
  return rows.length === 1 ? rows[0].id : null;
}

async function contactByEmail(db: Db, workspaceId: number, email: string): Promise<number | null> {
  const rows = await q<{ id: number }>(sql`
    SELECT DISTINCT c.id FROM contact_methods m JOIN contacts c ON c.id = m.party_id
    WHERE m.workspace_id = ${workspaceId} AND m.party_type = 'contact' AND m.kind = 'email' AND m.normalized = ${email.trim().toLowerCase()}
      AND c.deleted_at IS NULL LIMIT 2`, db);
  return rows.length === 1 ? rows[0].id : null;
}
