/**
 * Telegram bots (official Bot API). People write to the bot in a private chat, or in a group the bot was added to;
 * replies from the Inbox are sent as the bot.
 *
 * Delivery: when APP_URL is https, Telegram pushes updates to /api/v1/hooks/telegram/:key (checked with a secret
 * header). Otherwise (local development) the worker polls getUpdates every few seconds.
 *
 * Groups: by default a bot only sees commands and replies to it in groups. To receive every group message, turn off
 * privacy mode in @BotFather (/setprivacy → Disable) before adding the bot to the group.
 */
import { randomBytes } from 'node:crypto';
import { config } from '../config.ts';
import { pool, q, q1, sql, tx, type Db } from '../db/index.ts';
import { AppError } from '../lib/errors.ts';
import { openSecret } from '../lib/secrets.ts';
import { recordInbound, type ChannelRow } from './store.ts';
import { fileRefOf, queueIncomingFile } from './files.ts';
import { handleLinkStart } from './teamAlerts.ts';

export class TelegramError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const typingShown = new Map<number, number>();
/**
 * Shows "typing…" in the Telegram chat (Telegram keeps it for about 5 seconds). At most once every 4 seconds per
 * conversation; fire-and-forget, failures are ignored (it's only a hint).
 */
export function showTelegramTyping(channelId: number, conversationId: number): void {
  const now = Date.now();
  if ((typingShown.get(conversationId) ?? 0) > now - 4000) return;
  typingShown.set(conversationId, now);
  if (typingShown.size > 5000) for (const [k, t] of typingShown) if (t < now - 10_000) typingShown.delete(k);
  void (async () => {
    const c = await q1<{ secret: string | null; external_id: string }>(sql`SELECT ch.secret, cv.external_id FROM channels ch
      JOIN conversations cv ON cv.channel_id = ch.id WHERE ch.id = ${channelId} AND cv.id = ${conversationId}`);
    if (c?.secret) await tg(openSecret(c.secret), 'sendChatAction', { chat_id: c.external_id, action: 'typing' });
  })().catch(() => {});
}

/** Calls a Bot API method. Throws TelegramError with Telegram's description on failure. */
export async function tg<T>(token: string, method: string, params: Record<string, unknown> = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${config.telegram.apiUrl}/bot${token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params), signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new TelegramError(0, `Telegram could not be reached (${e instanceof Error ? e.message : String(e)})`);
  }
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
  if (!res.ok || !body.ok) throw new TelegramError(res.status, body.description ?? `Telegram answered ${res.status}`);
  return body.result as T;
}

interface TgUser { id: number; is_bot?: boolean; first_name?: string; last_name?: string; username?: string }
interface TgChat { id: number; type: 'private' | 'group' | 'supergroup' | 'channel'; title?: string; first_name?: string; last_name?: string; username?: string }
export interface TgFile { file_id: string; file_name?: string; mime_type?: string; file_size?: number }
export interface TgMessage {
  message_id: number; from?: TgUser; chat: TgChat; date: number;
  text?: string; caption?: string;
  photo?: TgFile[]; document?: TgFile; sticker?: { emoji?: string }; voice?: TgFile; audio?: TgFile;
  video?: TgFile; video_note?: TgFile; animation?: TgFile; location?: { latitude: number; longitude: number };
  contact?: { phone_number: string; first_name?: string; last_name?: string }; poll?: { question: string };
}
export interface TgUpdate { update_id: number; message?: TgMessage }

const fullName = (u: { first_name?: string; last_name?: string; username?: string }) =>
  [u.first_name, u.last_name].filter(Boolean).join(' ') || (u.username ? `@${u.username}` : '');

/** Text shown in the Inbox for a Telegram message; null for service messages (joins, pins…) we don't show. */
export function describeMessage(m: TgMessage): string | null {
  const cap = m.caption ? ` ${m.caption}` : '';
  if (m.text) return m.text;
  if (m.photo) return `[Photo]${cap}`;
  if (m.video || m.animation || m.video_note) return `[Video]${cap}`;
  if (m.voice || m.audio) return `[Audio]${cap}`;
  if (m.document) return `[File: ${m.document.file_name ?? 'attachment'}]${cap}`;
  if (m.sticker) return `[Sticker${m.sticker.emoji ? ` ${m.sticker.emoji}` : ''}]`;
  if (m.location) return `[Location: ${m.location.latitude}, ${m.location.longitude}]`;
  if (m.contact) return `[Contact: ${fullName(m.contact)} ${m.contact.phone_number}]`;
  if (m.poll) return `[Poll: ${m.poll.question}]`;
  return null;
}

/** Stores one Telegram update. Messages from bots (including our own echoes) and service messages are skipped. */
export async function ingestUpdate(db: Db, channel: ChannelRow, u: TgUpdate): Promise<boolean> {
  const m = u.message;
  if (!m || m.from?.is_bot || m.chat.type === 'channel') return false;
  // A team member connecting their Telegram for notifications: not an Inbox message.
  if (await handleLinkStart(db, channel, m)) return false;
  const body = describeMessage(m);
  if (body === null) return false;
  const group = m.chat.type !== 'private';
  const sender = m.from ? fullName(m.from) : '';
  const r = await recordInbound(db, {
    channel,
    chatId: String(m.chat.id),
    kind: group ? 'group' : 'direct',
    title: group ? (m.chat.title ?? 'Telegram group') : (fullName(m.chat) || sender || 'Telegram user'),
    profile: group ? { name: m.chat.title, username: m.chat.username, platformId: String(m.chat.id) }
      : { name: fullName(m.chat), username: m.chat.username, platformId: String(m.chat.id), phone: m.contact?.phone_number },
    messageId: String(m.message_id),
    senderName: sender,
    body,
  });
  if (!r) return false;
  const file = fileRefOf(m);
  if (file) await queueIncomingFile(db, channel.workspace_id, r.messageId, file);
  return true;
}

const tokenOf = (c: ChannelRow) => openSecret(c.secret!);
const useWebhook = () => config.appUrl.startsWith('https://');
export const webhookUrl = (c: { public_key: string }) => `${config.appUrl.replace(/\/$/, '')}/api/v1/hooks/telegram/${c.public_key}`;

/**
 * Checks the token (getMe) and sets up delivery. Returns what to store on the channel.
 * Telegram refuses webhooks on non-https URLs, so local development polls instead.
 */
export async function connectBot(token: string, publicKey: string): Promise<{ username: string; botName: string; mode: 'webhook' | 'polling'; webhookSecret: string }> {
  let me: TgUser;
  try { me = await tg<TgUser>(token, 'getMe'); }
  catch (e) {
    const status = e instanceof TelegramError ? e.status : 0;
    throw new AppError(422, 'TELEGRAM_TOKEN', status === 401 || status === 404 ? 'Telegram did not accept this token. Copy it again from @BotFather.' : (e as Error).message);
  }
  const webhookSecret = randomBytes(24).toString('hex');
  if (useWebhook()) {
    await tg(token, 'setWebhook', { url: webhookUrl({ public_key: publicKey }), secret_token: webhookSecret, allowed_updates: ['message'] });
    return { username: me.username ?? '', botName: fullName(me), mode: 'webhook', webhookSecret };
  }
  await tg(token, 'deleteWebhook', {}); // a webhook left from elsewhere would block getUpdates
  return { username: me.username ?? '', botName: fullName(me), mode: 'polling', webhookSecret };
}

/** Best effort when a channel is removed or disabled: stop Telegram pushing updates to us. */
export async function disconnectBot(c: ChannelRow): Promise<void> {
  if (!c.secret) return;
  try { await tg(tokenOf(c), 'deleteWebhook', {}); } catch { /* token revoked or Telegram down: nothing to undo */ }
}

/** Sends a reply. Returns Telegram's message id. */
export async function sendTelegram(c: ChannelRow, chatId: string, text: string): Promise<string> {
  const r = await tg<{ message_id: number }>(tokenOf(c), 'sendMessage', { chat_id: chatId, text });
  return String(r.message_id);
}

/**
 * Polls every active bot in polling mode once. Each channel is locked while it is polled (SKIP LOCKED), so the API's
 * inline worker and a separate worker never read the same updates twice. Returns the number of stored messages.
 */
export async function pollTelegram(): Promise<number> {
  const ids = await q<{ id: number }>(sql`SELECT id FROM channels WHERE kind = 'telegram_bot' AND status = 'active' AND config->>'mode' = 'polling'`);
  let stored = 0;
  for (const { id } of ids) {
    stored += await tx(async (db) => {
      const c = await q<ChannelRow>(sql`SELECT * FROM channels WHERE id = ${id} AND status = 'active' FOR UPDATE SKIP LOCKED`, db);
      if (!c[0]) return 0;
      const ch = c[0];
      const offset = Number(ch.config.offset ?? 0);
      let updates: TgUpdate[];
      try {
        updates = await tg<TgUpdate[]>(tokenOf(ch), 'getUpdates', { offset, timeout: 0, limit: 100, allowed_updates: ['message'] });
      } catch (e) {
        if (e instanceof TelegramError && (e.status === 401 || e.status === 404)) {
          await q(sql`UPDATE channels SET status = 'error', last_error = 'Telegram no longer accepts this bot token. Reconnect the bot with a new token.' WHERE id = ${id}`, db);
        }
        return 0;
      }
      let n = 0;
      for (const u of updates) if (await ingestUpdate(db, ch, u)) n++;
      if (updates.length) {
        const next = Math.max(...updates.map((u) => u.update_id)) + 1;
        await q(sql`UPDATE channels SET config = config || ${JSON.stringify({ offset: next })}::jsonb, last_error = NULL WHERE id = ${id}`, db);
      }
      return n;
    });
  }
  return stored;
}

export async function channelByKey(key: string, db: Db = pool): Promise<ChannelRow | null> {
  return (await q<ChannelRow>(sql`SELECT * FROM channels WHERE public_key = ${key}`, db))[0] ?? null;
}
