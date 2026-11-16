/** Sending Inbox replies to the platform (job "inbox.send", retried by the jobs queue). */
import { q, q1, sql } from '../db/index.ts';
import type { ChannelRow } from './store.ts';
import { sendTelegram, TelegramError } from './telegram.ts';

/** Delivers one pending outgoing message. Permanent refusals (bot blocked, removed from the group) fail at once. */
export async function deliverMessage(messageId: number): Promise<void> {
  const m = await q1<{ id: number; body: string; status: string; chat_id: string; channel_id: number }>(sql`
    SELECT m.id, m.body, m.status, c.external_id AS chat_id, c.channel_id
    FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.id = ${messageId}`);
  if (!m || m.status !== 'pending') return;
  const ch = await q1<ChannelRow>(sql`SELECT * FROM channels WHERE id = ${m.channel_id}`);
  if (!ch || ch.status === 'disabled') return markFailed(messageId, 'The channel is disabled, so the message was not sent.');
  if (ch.kind !== 'telegram_bot') return markFailed(messageId, 'This channel cannot send messages.');
  try {
    const externalId = await sendTelegram(ch, m.chat_id, m.body);
    await q(sql`UPDATE messages SET status = 'sent', external_id = ${externalId}, error = NULL WHERE id = ${messageId}`);
  } catch (e) {
    if (e instanceof TelegramError && (e.status === 400 || e.status === 403)) return markFailed(messageId, `Telegram refused the message: ${e.message}`);
    throw e; // network or Telegram outage: the jobs queue retries
  }
}

export async function markFailed(messageId: number, error: string): Promise<void> {
  await q(sql`UPDATE messages SET status = 'failed', error = ${error} WHERE id = ${messageId} AND status = 'pending'`);
}
