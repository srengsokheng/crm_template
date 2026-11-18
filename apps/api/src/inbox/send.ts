/** Sending Inbox replies to the platform (job "inbox.send", retried by the jobs queue). */
import { pool, q, q1, sql } from '../db/index.ts';
import { notifyInbox } from './events.ts';
import { files } from '../lib/files.ts';
import { openSecret } from '../lib/secrets.ts';
import { sendTelegramFile } from './files.ts';
import type { ChannelRow } from './store.ts';
import { sendTelegram, TelegramError } from './telegram.ts';
import { isMetaKind } from '@crm/shared';
import { MetaError, refusalText, sendMeta, type TemplateRef } from './meta.ts';
import { sendTgUser, tgUserRefusal } from './telegramUser.ts';

const CAPTION_MAX = 1024; // Telegram's caption limit; longer text is sent as its own message after the file

/** Delivers one pending outgoing message. Permanent refusals (bot blocked, removed from the group) fail at once. */
export async function deliverMessage(messageId: number): Promise<void> {
  const m = await q1<{ id: number; body: string; status: string; chat_id: string; channel_id: number; conversation_id: number; platform_ref: string | null; template: TemplateRef | null }>(sql`
    SELECT m.id, m.body, m.status, c.external_id AS chat_id, c.channel_id, m.conversation_id, c.platform_ref, m.template
    FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.id = ${messageId}`);
  if (!m || m.status !== 'pending') return;
  const ch = await q1<ChannelRow>(sql`SELECT * FROM channels WHERE id = ${m.channel_id}`);
  if (!ch || ch.status === 'disabled') return markFailed(messageId, 'The channel is disabled, so the message was not sent.');
  const file = await q1<{ file_name: string; content_type: string; storage_key: string }>(sql`
    SELECT file_name, content_type, storage_key FROM message_files WHERE message_id = ${messageId} AND status = 'stored' LIMIT 1`);
  if (isMetaKind(ch.kind)) {
    try {
      const data = file ? await files().get(file.storage_key) : null;
      if (file && !data) return markFailed(messageId, 'The file is missing from storage.');
      const externalId = await sendMeta(ch, m.chat_id, m.body, file && data ? { ...file, data } : null, m.template);
      await q(sql`UPDATE messages SET status = 'sent', external_id = ${externalId}, error = NULL WHERE id = ${messageId}`);
      await notifyInbox(pool, m.conversation_id);
      return;
    } catch (e) {
      const why = e instanceof MetaError ? refusalText(ch.kind, e) : null;
      if (!why) throw e; // outage or rate limit: the jobs queue retries
      if (e instanceof MetaError && e.code === 190) {
        await q(sql`UPDATE channels SET status = 'error', last_error = 'Meta no longer accepts the access token. Update it with a new long-lived token.' WHERE id = ${ch.id}`);
      }
      return markFailed(messageId, why);
    }
  }
  if (ch.kind === 'telegram_user') {
    if (!m.platform_ref) return markFailed(messageId, 'Telegram can’t find this chat any more.');
    try {
      const data = file ? await files().get(file.storage_key) : null;
      if (file && !data) return markFailed(messageId, 'The file is missing from storage.');
      const externalId = await sendTgUser(ch, m.platform_ref, m.body, file && data ? { ...file, data } : null);
      await q(sql`UPDATE messages SET status = 'sent', external_id = ${externalId}, error = NULL WHERE id = ${messageId}`);
      await notifyInbox(pool, m.conversation_id);
      return;
    } catch (e) {
      const why = tgUserRefusal(e);
      if (!why) throw e; // flood wait or network: the jobs queue retries
      return markFailed(messageId, why);
    }
  }
  if (ch.kind !== 'telegram_bot') return markFailed(messageId, 'This channel cannot send messages.');
  try {
    let externalId: string;
    if (file) {
      const data = await files().get(file.storage_key);
      if (!data) return markFailed(messageId, 'The file is missing from storage.');
      const fits = m.body.length <= CAPTION_MAX;
      externalId = await sendTelegramFile(openSecret(ch.secret!), m.chat_id, file, data, fits ? m.body : '');
      if (!fits) externalId = await sendTelegram(ch, m.chat_id, m.body);
    } else {
      externalId = await sendTelegram(ch, m.chat_id, m.body);
    }
    await q(sql`UPDATE messages SET status = 'sent', external_id = ${externalId}, error = NULL WHERE id = ${messageId}`);
    await notifyInbox(pool, m.conversation_id);
  } catch (e) {
    if (e instanceof TelegramError && (e.status === 400 || e.status === 403)) return markFailed(messageId, `Telegram refused the message: ${e.message}`);
    throw e; // network or Telegram outage: the jobs queue retries
  }
}

export async function markFailed(messageId: number, error: string): Promise<void> {
  const r = await q1<{ conversation_id: number }>(sql`UPDATE messages SET status = 'failed', error = ${error} WHERE id = ${messageId} AND status = 'pending' RETURNING conversation_id`);
  if (r) await notifyInbox(pool, r.conversation_id);
}
