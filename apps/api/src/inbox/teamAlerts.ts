/**
 * Team notifications on Telegram, through the workspace's Telegram bot (Settings → Channels).
 *
 * Linking: in Settings → Your account, "Connect Telegram" makes a one-time code (15 minutes) and opens
 * t.me/<bot>?start=<code>. Telegram sends "/start <code>" to the bot; we link that private chat to the person and
 * answer there. These messages never become Inbox conversations.
 *
 * Sending: the worker forwards each new in-app notification of a linked person (newest first are not skipped:
 * oldest first, 50 at a time) with a link back into the CRM. If the person blocks the bot, the link is removed.
 */
import { createHash, randomBytes } from 'node:crypto';
import { config } from '../config.ts';
import { pool, q, q1, sql, tx, type Db } from '../db/index.ts';
import { openSecret } from '../lib/secrets.ts';
import type { ChannelRow } from './store.ts';
import { tg, TelegramError, type TgMessage } from './telegram.ts';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');

/** The bot that sends team notifications: the workspace's first active Telegram bot. */
export async function alertBot(workspaceId: number, db: Db = pool): Promise<ChannelRow | null> {
  return (await q1<ChannelRow>(sql`SELECT * FROM channels WHERE workspace_id = ${workspaceId} AND kind = 'telegram_bot' AND status = 'active'
    AND coalesce(config->>'username', '') <> '' ORDER BY id LIMIT 1`, db)) ?? null;
}

export async function startLink(workspaceId: number, userId: number): Promise<{ url: string; botUsername: string; expiresAt: Date } | null> {
  const bot = await alertBot(workspaceId);
  if (!bot) return null;
  const code = randomBytes(12).toString('base64url'); // Telegram start parameters: A–Z a–z 0–9 _ - (up to 64)
  const expiresAt = new Date(Date.now() + 15 * 60_000);
  await q(sql`DELETE FROM telegram_link_codes WHERE user_id = ${userId} AND workspace_id = ${workspaceId}`);
  await q(sql`INSERT INTO telegram_link_codes (code_hash, workspace_id, user_id, expires_at) VALUES (${hash(code)}, ${workspaceId}, ${userId}, ${expiresAt})`);
  const username = String(bot.config.username);
  return { url: `https://t.me/${username}?start=${code}`, botUsername: username, expiresAt };
}

async function reply(c: ChannelRow, chatId: number | string, text: string) {
  try { await tg(openSecret(c.secret!), 'sendMessage', { chat_id: String(chatId), text, disable_web_page_preview: true }); } catch { /* best effort */ }
}

/**
 * "/start <code>" in a private chat with the bot: links the person if the code is theirs and still valid. Returns true
 * when the message was such a link attempt (it then stays out of the Inbox).
 */
export async function handleLinkStart(db: Db, channel: ChannelRow, m: TgMessage): Promise<boolean> {
  const match = /^\/start\s+([A-Za-z0-9_-]{8,64})$/.exec((m.text ?? '').trim());
  if (!match || m.chat.type !== 'private' || !m.from) return false;
  const code = await q1<{ user_id: number; expires_at: Date }>(sql`DELETE FROM telegram_link_codes
    WHERE code_hash = ${hash(match[1])} AND workspace_id = ${channel.workspace_id} RETURNING user_id, expires_at`, db);
  if (!code || new Date(code.expires_at) < new Date()) {
    await reply(channel, m.chat.id, 'This link has expired or was already used. Open the CRM → Your account → Telegram notifications and connect again.');
    return true;
  }
  const name = [m.from.first_name, m.from.last_name].filter(Boolean).join(' ') || (m.from.username ? `@${m.from.username}` : '');
  await q(sql`INSERT INTO user_telegram (workspace_id, user_id, channel_id, chat_id, tg_name) VALUES (${channel.workspace_id}, ${code.user_id}, ${channel.id}, ${String(m.chat.id)}, ${name})
    ON CONFLICT (workspace_id, user_id) DO UPDATE SET channel_id = EXCLUDED.channel_id, chat_id = EXCLUDED.chat_id, tg_name = EXCLUDED.tg_name, linked_at = now()`, db);
  // Only what happens from now on is sent.
  await q(sql`UPDATE notifications SET pushed_at = now() WHERE user_id = ${code.user_id} AND workspace_id = ${channel.workspace_id} AND pushed_at IS NULL`, db);
  const ws = await q1<{ name: string }>(sql`SELECT name FROM workspaces WHERE id = ${channel.workspace_id}`, db);
  await reply(channel, m.chat.id, `✅ Connected to ${ws?.name ?? 'the CRM'}. Your CRM notifications will arrive here. To stop, open Your account in the CRM.`);
  return true;
}

/** Where a notification leads in the app. */
function linkOf(n: { entity_type: string | null; entity_id: number | null }): string {
  const base = config.appUrl.replace(/\/$/, '');
  const path: Record<string, string> = { deal: '/deals/', lead: '/leads/', contact: '/contacts/', company: '/companies/', conversation: '/inbox/' };
  if (n.entity_type && n.entity_id && path[n.entity_type]) return `${base}${path[n.entity_type]}${n.entity_id}`;
  if (n.entity_type === 'activity') return `${base}/activities`;
  return base;
}

/** Worker: sends new notifications of linked people to their Telegram. Returns how many were sent. */
export async function pushNotifications(limit = 50): Promise<number> {
  return tx(async (db) => {
    const rows = await q<{ id: number; title: string; body: string | null; entity_type: string | null; entity_id: number | null; chat_id: string; channel_id: number; user_id: number; workspace_id: number }>(sql`
      SELECT n.id, n.title, n.body, n.entity_type, n.entity_id, ut.chat_id, ut.channel_id, n.user_id, n.workspace_id
      FROM notifications n JOIN user_telegram ut ON ut.user_id = n.user_id AND ut.workspace_id = n.workspace_id
      WHERE n.pushed_at IS NULL ORDER BY n.id LIMIT ${limit} FOR UPDATE OF n SKIP LOCKED`, db);
    let sent = 0;
    for (const n of rows) {
      const ch = await q1<ChannelRow>(sql`SELECT * FROM channels WHERE id = ${n.channel_id} AND status = 'active'`, db);
      if (!ch?.secret) continue; // bot disabled: keep for when it's back
      const text = `🔔 ${n.title}${n.body ? `\n${n.body}` : ''}\n${linkOf(n)}`.slice(0, 4000);
      try {
        await tg(openSecret(ch.secret), 'sendMessage', { chat_id: n.chat_id, text, disable_web_page_preview: true });
        sent++;
      } catch (e) {
        if (e instanceof TelegramError && (e.status === 403 || e.status === 400)) {
          // Blocked the bot or the chat is gone: stop sending (they can connect again).
          await q(sql`DELETE FROM user_telegram WHERE user_id = ${n.user_id} AND workspace_id = ${n.workspace_id}`, db);
        } else {
          continue; // Telegram unreachable: try again next round
        }
      }
      await q(sql`UPDATE notifications SET pushed_at = now() WHERE id = ${n.id}`, db);
    }
    return sent;
  });
}
