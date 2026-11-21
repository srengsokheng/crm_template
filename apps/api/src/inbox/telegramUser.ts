/**
 * A Telegram personal account in the Inbox (Telegram's user API, MTProto — not a bot). Messages people send to the
 * account arrive in the Inbox; replies are sent as that account.
 *
 * Signing in (Settings → Channels, admins): api_id/api_hash from my.telegram.org and the phone number → Telegram sends
 * a code to the account's Telegram apps → the admin types it (and the account's 2FA password, if set; never stored).
 * The session is stored encrypted (SECRETS_KEY) with api_id/api_hash; every step works across API processes.
 *
 * Privacy: by default only private chats are taken in (groups are opt-in), and new conversations are assigned to the
 * account's owner, so only people who may see the owner's conversations see them.
 *
 * Receiving: the worker keeps one live connection per account (a Postgres advisory lock makes sure only one process
 * holds it). On (re)connect it fetches unread messages of recent chats, so restarts don't lose messages.
 * Only incoming messages are taken in; what the owner writes from their phone stays on Telegram.
 *
 * The MTProto client sits behind TgUserDriver (real one: telegramUserGram.ts, GramJS); tests use a fake.
 */
import type pg from 'pg';
import { pool, q, q1, sql, tx } from '../db/index.ts';
import { AppError } from '../lib/errors.ts';
import { openSecret, sealSecret } from '../lib/secrets.ts';
import { notifyInbox } from './events.ts';
import { queueIncomingFile } from './files.ts';
import { recordInbound, type ChannelRow } from './store.ts';

export class TgUserError extends Error {
  code: string; seconds: number | null;
  constructor(code: string, message?: string, seconds: number | null = null) { super(message ?? code); this.code = code; this.seconds = seconds; }
}

export interface TgUserIncoming {
  chatId: string; chatKind: 'direct' | 'group'; chatTitle: string;
  /** How to address the chat later ("user:<id>:<hash>", "chat:<id>", "channel:<id>:<hash>"). */
  peerRef: string;
  messageId: string; senderName: string; senderUsername?: string; senderPhone?: string;
  body: string;
  file: { fileName: string; contentType: string; size: number | null } | null;
}

export interface TgUserSession {
  /** The session as a string, to store after a step changed it. */
  save(): string;
  sendCode(phone: string): Promise<{ phoneCodeHash: string }>;
  /** "password" when the account has two-step verification. */
  signIn(phone: string, phoneCodeHash: string, code: string): Promise<'ok' | 'password'>;
  checkPassword(password: string): Promise<void>;
  me(): Promise<{ id: string; username: string | null; name: string; phone: string | null }>;
  /** Calls back for each new incoming message (private chats; groups when asked). */
  listen(onMessage: (m: TgUserIncoming) => void, opts: { groups: boolean }): void;
  /** Unread incoming messages of the most recent chats (catch-up after a restart). */
  unread(opts: { groups: boolean }): Promise<TgUserIncoming[]>;
  sendText(peerRef: string, text: string): Promise<string>;
  sendFile(peerRef: string, file: { fileName: string; contentType: string; data: Buffer }, caption: string): Promise<string>;
  download(peerRef: string, messageId: string): Promise<Buffer | null>;
  typing(peerRef: string): Promise<void>;
  logOut(): Promise<void>;
  close(): Promise<void>;
}
export interface TgUserDriver { open(apiId: number, apiHash: string, session: string): Promise<TgUserSession> }

let driver: TgUserDriver | null = null;
/** Tests (and the e2e server) install a fake; otherwise GramJS is loaded on first use. */
export function setTgUserDriver(d: TgUserDriver | null) { driver = d; }
async function getDriver(): Promise<TgUserDriver> {
  driver ??= (await import('./telegramUserGram.ts')).gramDriver;
  return driver;
}

interface Stored { apiId: number; apiHash: string; session: string; phone: string; phoneCodeHash?: string }
export const sealTgUser = (s: Stored) => sealSecret(JSON.stringify(s));
export const openTgUser = (c: { secret: string | null }): Stored => JSON.parse(openSecret(c.secret!)) as Stored;

export async function openSession(s: Pick<Stored, 'apiId' | 'apiHash' | 'session'>): Promise<TgUserSession> {
  return (await getDriver()).open(s.apiId, s.apiHash, s.session);
}

/** Telegram's sign-in errors in words. */
export function loginError(e: unknown): AppError {
  if (!(e instanceof TgUserError)) return new AppError(502, 'TELEGRAM', `Telegram could not be reached: ${e instanceof Error ? e.message : String(e)}`);
  const m: Record<string, string> = {
    API_ID_INVALID: 'Telegram did not accept the api_id / api_hash. Copy them again from my.telegram.org → API development tools.',
    API_ID_PUBLISHED_FLOOD: 'Telegram blocked this api_id. Create your own at my.telegram.org.',
    PHONE_NUMBER_INVALID: 'Telegram doesn’t know this phone number. Use the full number with the country code, like +855 12 345 678.',
    PHONE_NUMBER_BANNED: 'Telegram has banned this phone number.',
    PHONE_CODE_INVALID: 'That code isn’t right. Check the latest message from Telegram and try again.',
    PHONE_CODE_EXPIRED: 'The code expired. Ask for a new one.',
    PHONE_CODE_EMPTY: 'Enter the code Telegram sent you.',
    PASSWORD_HASH_INVALID: 'That two-step verification password isn’t right.',
    SESSION_PASSWORD_NEEDED: 'This account has two-step verification: enter its password.',
  };
  if (e.code === 'FLOOD_WAIT') return new AppError(429, 'RATE_LIMITED', `Telegram asks to wait ${e.seconds ?? 60} seconds before trying again.`);
  return new AppError(422, 'TELEGRAM_LOGIN', m[e.code] ?? `Telegram refused: ${e.message}`);
}

/** Codes meaning the session is gone (logged out on the phone, terminated in Settings → Devices, …). */
export const SESSION_GONE = new Set(['AUTH_KEY_UNREGISTERED', 'SESSION_REVOKED', 'SESSION_EXPIRED', 'USER_DEACTIVATED', 'USER_DEACTIVATED_BAN', 'AUTH_KEY_DUPLICATED']);
const GONE_TEXT = 'Telegram ended this session (for example it was terminated under Settings → Devices). Connect the account again.';

// ---------------------------------------------------------------------------------------------------------------
// Ingest

/** Stores one incoming message; a new conversation is assigned to the account's owner. */
export async function ingestTgUser(channel: ChannelRow, m: TgUserIncoming): Promise<boolean> {
  return tx(async (db) => {
    const r = await recordInbound(db, {
      channel, chatId: m.chatId, kind: m.chatKind, title: m.chatTitle || m.senderName || 'Telegram user',
      profile: m.chatKind === 'group' ? { name: m.chatTitle, platformId: m.chatId }
        : { name: m.senderName, username: m.senderUsername, phone: m.senderPhone, platformId: m.chatId },
      messageId: m.messageId, senderName: m.senderName, body: m.body,
    });
    if (!r) return false;
    await q(sql`UPDATE conversations SET platform_ref = ${m.peerRef} WHERE id = ${r.conversationId}`, db);
    const owner = Number(channel.config.ownerId) || null;
    if (owner) {
      const first = await q1(sql`SELECT 1 FROM messages WHERE conversation_id = ${r.conversationId} AND id <> ${r.messageId} LIMIT 1`, db);
      if (!first) {
        await q(sql`UPDATE conversations SET assignee_id = ${owner} WHERE id = ${r.conversationId} AND assignee_id IS NULL
          AND EXISTS (SELECT 1 FROM memberships WHERE user_id = ${owner} AND workspace_id = ${channel.workspace_id} AND status = 'active')`, db);
        await notifyInbox(db, r.conversationId);
      }
    }
    if (m.file) await queueIncomingFile(db, channel.workspace_id, r.messageId, { fileId: `tgu:${m.messageId}`, ...m.file });
    return true;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Live connections (worker)

interface Live { session: TgUserSession; lock: pg.PoolClient; groups: boolean }
const live = new Map<number, Live>();
const LOCK_SPACE = 74_201; // advisory lock namespace for these connections

async function markGone(id: number, text = GONE_TEXT) {
  await q(sql`UPDATE channels SET status = 'error', last_error = ${text} WHERE id = ${id} AND status = 'active'`);
}

async function drop(id: number) {
  const l = live.get(id);
  if (!l) return;
  live.delete(id);
  try { await l.session.close(); } catch { /* already closed */ }
  try { await l.lock.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_SPACE, id]); } catch { /* connection gone */ }
  l.lock.release();
}

/**
 * Keeps one live connection per active account in this process if no other process has it. Called by the worker
 * every few seconds; returns the number of messages stored by the catch-up.
 */
export async function syncTelegramUsers(log: (m: string) => void = () => {}): Promise<number> {
  const rows = await q<ChannelRow>(sql`SELECT * FROM channels WHERE kind = 'telegram_user' AND status = 'active'`);
  const active = new Set(rows.map((r) => r.id));
  for (const id of [...live.keys()]) if (!active.has(id)) await drop(id);
  let stored = 0;
  for (const c of rows) {
    // A changed "include groups" setting takes effect by reconnecting.
    if (live.has(c.id) && live.get(c.id)!.groups !== (c.config.includeGroups === true)) await drop(c.id);
    if (live.has(c.id)) continue;
    const lock = await pool.connect();
    try {
      const held = (await lock.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1, $2) AS ok', [LOCK_SPACE, c.id])).rows[0].ok;
      if (!held) { lock.release(); continue; }
      const s = openTgUser(c);
      const session = await openSession(s);
      const groups = c.config.includeGroups === true;
      live.set(c.id, { session, lock, groups });
      // Groups are only taken in when the channel says so (checked here too, not only by the driver).
      const wanted = (m: TgUserIncoming) => m.chatKind === 'direct' || groups;
      session.listen((m) => {
        if (!wanted(m)) return;
        void ingestTgUser(c, m).catch((e) => log(`telegram account ${c.id}: ${e instanceof Error ? e.message : String(e)}`));
      }, { groups });
      for (const m of await session.unread({ groups })) if (wanted(m) && await ingestTgUser(c, m)) stored++;
    } catch (e) {
      // Release the lock: through drop() when the connection was registered, directly otherwise.
      if (live.has(c.id)) await drop(c.id).catch(() => {});
      else { try { await lock.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_SPACE, c.id]); } catch { /* connection gone */ } lock.release(); }
      if (e instanceof TgUserError && SESSION_GONE.has(e.code)) await markGone(c.id);
      else log(`telegram account ${c.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return stored;
}

/** On shutdown (and in tests): close every live connection. */
export async function stopTelegramUsers(): Promise<void> {
  for (const id of [...live.keys()]) await drop(id);
}
export const liveTelegramUsers = () => [...live.keys()];

/** Runs fn with this process's live session, or a short-lived one. */
async function withSession<T>(c: ChannelRow, fn: (s: TgUserSession) => Promise<T>): Promise<T> {
  const l = live.get(c.id);
  if (l) return fn(l.session);
  const s = await openSession(openTgUser(c));
  try { return await fn(s); } finally { await s.close().catch(() => {}); }
}

// ---------------------------------------------------------------------------------------------------------------
// Sending, files, typing

/** Sends a reply as the account. Returns Telegram's message id; TgUserError for refusals. */
export async function sendTgUser(c: ChannelRow, peerRef: string, text: string, file: { file_name: string; content_type: string; data: Buffer } | null): Promise<string> {
  try {
    return await withSession(c, async (s) => {
      if (!file) return s.sendText(peerRef, text);
      const fits = [...text].length <= 1024;
      let id = await s.sendFile(peerRef, { fileName: file.file_name, contentType: file.content_type, data: file.data }, fits ? text : '');
      if (!fits) id = await s.sendText(peerRef, text);
      return id;
    });
  } catch (e) {
    if (e instanceof TgUserError && SESSION_GONE.has(e.code)) await markGone(c.id);
    throw e;
  }
}

/** Why a reply can't be sent (shown on the message); null when worth retrying. */
export function tgUserRefusal(e: unknown): string | null {
  if (!(e instanceof TgUserError)) return null;
  if (e.code === 'FLOOD_WAIT') return null;
  if (SESSION_GONE.has(e.code)) return GONE_TEXT;
  const m: Record<string, string> = {
    USER_IS_BLOCKED: 'This person blocked the account.',
    YOU_BLOCKED_USER: 'The account blocked this person. Unblock them in Telegram first.',
    INPUT_USER_DEACTIVATED: 'This person deleted their Telegram account.',
    PEER_ID_INVALID: 'Telegram can’t find this chat any more.',
    CHAT_WRITE_FORBIDDEN: 'The account can’t write in this group.',
    USER_PRIVACY_RESTRICTED: 'This person’s privacy settings don’t allow the message.',
    PRIVACY_PREMIUM_REQUIRED: 'This person only accepts messages from contacts or Premium users.',
  };
  return m[e.code] ?? `Telegram refused the message: ${e.message}`;
}

export async function fetchTgUserFile(fileRowId: number, c: ChannelRow, ref: string, peerRef: string | null): Promise<Buffer | null> {
  if (!peerRef || !ref.startsWith('tgu:')) return null;
  return withSession(c, (s) => s.download(peerRef, ref.slice(4)));
}

const typingShown = new Map<number, number>();
/** "typing…" in the Telegram chat, at most every 4 s; only through a live connection (otherwise skipped). */
export function showTgUserTyping(channelId: number, conversationId: number): void {
  const l = live.get(channelId);
  if (!l) return;
  const now = Date.now();
  if ((typingShown.get(conversationId) ?? 0) > now - 4000) return;
  typingShown.set(conversationId, now);
  void (async () => {
    const r = await q1<{ platform_ref: string | null }>(sql`SELECT platform_ref FROM conversations WHERE id = ${conversationId}`);
    if (r?.platform_ref) await l.session.typing(r.platform_ref);
  })().catch(() => {});
}

/** Best effort when the channel is deleted: end the session on Telegram (it disappears from the account's devices). */
/**
 * Starts signing in: asks Telegram to send a code to the account. Returns the session (with Telegram's handshake) and
 * the code's hash, to store until the code is entered.
 */
export async function startLogin(apiId: number, apiHash: string, phone: string): Promise<{ session: string; phoneCodeHash: string }> {
  let s: TgUserSession | null = null;
  try {
    s = await openSession({ apiId, apiHash, session: '' });
    const { phoneCodeHash } = await s.sendCode(phone);
    return { session: s.save(), phoneCodeHash };
  } catch (e) { throw loginError(e); } finally { await s?.close().catch(() => {}); }
}

/** One sign-in step with the stored session. "password" = the account has two-step verification. */
export async function loginStep(stored: Stored, step: { code: string } | { password: string }): Promise<{ result: 'ok' | 'password'; session: string; me: Awaited<ReturnType<TgUserSession['me']>> | null }> {
  let s: TgUserSession | null = null;
  try {
    s = await openSession(stored);
    let result: 'ok' | 'password';
    if ('code' in step) result = await s.signIn(stored.phone, stored.phoneCodeHash ?? '', step.code);
    else { await s.checkPassword(step.password); result = 'ok'; }
    return { result, session: s.save(), me: result === 'ok' ? await s.me() : null };
  } catch (e) { throw loginError(e); } finally { await s?.close().catch(() => {}); }
}

export async function logOutTgUser(c: ChannelRow): Promise<void> {
  await drop(c.id);
  if (!c.secret) return;
  try { const s = await openSession(openTgUser(c)); try { await s.logOut(); } finally { await s.close().catch(() => {}); } } catch { /* gone already */ }
}
