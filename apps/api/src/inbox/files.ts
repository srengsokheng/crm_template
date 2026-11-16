/**
 * Files on Inbox messages. Incoming Telegram files are downloaded by a job ("inbox.fetch_file") into the same storage
 * as record attachments (disk or S3, virus-scanned when ClamAV is configured). The Bot API only lets bots download
 * files up to 20 MB; larger ones (and anything over FILES_MAX_BYTES) are listed as "too large".
 */
import { config } from '../config.ts';
import { pool, q, q1, sql, type Db } from '../db/index.ts';
import { notifyInbox } from './events.ts';
import { files, newStorageKey } from '../lib/files.ts';
import { openSecret } from '../lib/secrets.ts';
import { scanBuffer } from '../lib/virusScan.ts';
import type { ChannelRow } from './store.ts';
import { tg, TelegramError, type TgMessage } from './telegram.ts';

export const BOT_DOWNLOAD_LIMIT = 20 * 1024 * 1024;
export const maxFileBytes = () => Math.min(config.files.maxBytes, BOT_DOWNLOAD_LIMIT);

export interface FileRef { fileId: string; fileName: string; contentType: string; size: number | null }

/** The downloadable file of a Telegram message, if any (stickers are left out: they're shown as an emoji). */
export function fileRefOf(m: TgMessage): FileRef | null {
  const id = m.message_id;
  if (m.photo?.length) {
    const p = m.photo[m.photo.length - 1]; // sizes come smallest first
    return { fileId: p.file_id, fileName: `photo-${id}.jpg`, contentType: 'image/jpeg', size: p.file_size ?? null };
  }
  const f = m.document ?? m.audio ?? m.video ?? m.animation ?? m.voice ?? m.video_note;
  if (!f) return null;
  const fallback = m.voice ? `voice-${id}.ogg` : m.video || m.video_note ? `video-${id}.mp4` : m.audio ? `audio-${id}.mp3` : `file-${id}`;
  const type = f.mime_type ?? (m.voice ? 'audio/ogg' : m.video || m.video_note || m.animation ? 'video/mp4' : 'application/octet-stream');
  return { fileId: f.file_id, fileName: f.file_name ?? fallback, contentType: type, size: f.file_size ?? null };
}

/** Records the file of an incoming message and queues its download (or marks it too large right away). */
export async function queueIncomingFile(db: Db, workspaceId: number, messageId: number, ref: FileRef): Promise<void> {
  const tooLarge = ref.size !== null && ref.size > maxFileBytes();
  const row = await q1<{ id: number }>(sql`INSERT INTO message_files (workspace_id, message_id, file_name, content_type, size_bytes, status, platform_file_id)
    VALUES (${workspaceId}, ${messageId}, ${ref.fileName.slice(0, 180)}, ${ref.contentType.slice(0, 100)}, ${ref.size}, ${tooLarge ? 'too_large' : 'pending'}, ${ref.fileId})
    RETURNING id`, db);
  if (!tooLarge) await q(sql`INSERT INTO jobs (type, payload, workspace_id) VALUES ('inbox.fetch_file', ${JSON.stringify({ fileId: row!.id })}, ${workspaceId})`, db);
}

/** Job: download one incoming Telegram file into storage. Throws on temporary errors so the queue retries. */
export async function fetchTelegramFile(fileRowId: number): Promise<void> {
  const f = await q1<{ id: number; workspace_id: number; status: string; platform_file_id: string; channel_id: number }>(sql`
    SELECT mf.id, mf.workspace_id, mf.status, mf.platform_file_id, cv.channel_id
    FROM message_files mf JOIN messages m ON m.id = mf.message_id JOIN conversations cv ON cv.id = m.conversation_id
    WHERE mf.id = ${fileRowId}`);
  if (!f || f.status !== 'pending') return;
  const ch = await q1<ChannelRow>(sql`SELECT * FROM channels WHERE id = ${f.channel_id}`);
  if (!ch?.secret) return setStatus(f.id, 'failed');
  const token = openSecret(ch.secret);
  let path: string;
  try {
    const info = await tg<{ file_path?: string; file_size?: number }>(token, 'getFile', { file_id: f.platform_file_id });
    if (!info.file_path) return setStatus(f.id, 'failed');
    if (info.file_size && info.file_size > maxFileBytes()) return setStatus(f.id, 'too_large', info.file_size);
    path = info.file_path;
  } catch (e) {
    if (e instanceof TelegramError && e.status === 400) return setStatus(f.id, /too big/i.test(e.message) ? 'too_large' : 'failed');
    throw e;
  }
  const res = await fetch(`${config.telegram.apiUrl}/file/bot${token}/${path}`, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Telegram file download answered ${res.status}`);
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length > maxFileBytes()) return setStatus(f.id, 'too_large', data.length);
  if (config.files.clamav.host) {
    const verdict = await scanBuffer(data, config.files.clamav); // scanner down → throw → retried later
    if (!verdict.clean) return setStatus(f.id, 'blocked', data.length);
  }
  const key = newStorageKey(f.workspace_id);
  await files().put(key, data);
  const done = await q1(sql`UPDATE message_files SET status = 'stored', storage_key = ${key}, size_bytes = ${data.length}
    WHERE id = ${f.id} AND status = 'pending' RETURNING id`);
  if (!done) return files().remove(key); // handled concurrently: keep the first copy
  await notifyFile(f.id);
}

export async function setStatus(id: number, status: 'too_large' | 'blocked' | 'failed', size?: number): Promise<void> {
  const r = await q1(sql`UPDATE message_files SET status = ${status}, size_bytes = coalesce(${size ?? null}::bigint, size_bytes)
    WHERE id = ${id} AND status = 'pending' RETURNING id`);
  if (r) await notifyFile(id);
}

async function notifyFile(fileId: number) {
  const m = await q1<{ conversation_id: number }>(sql`SELECT m.conversation_id FROM message_files f JOIN messages m ON m.id = f.message_id WHERE f.id = ${fileId}`);
  if (m) await notifyInbox(pool, m.conversation_id);
}

/** Sends a stored file through the bot (as a photo when Telegram can show it as one, otherwise as a document). */
export async function sendTelegramFile(token: string, chatId: string, file: { file_name: string; content_type: string }, data: Buffer, caption: string): Promise<string> {
  const asPhoto = ['image/jpeg', 'image/png', 'image/webp'].includes(file.content_type) && data.length <= 10 * 1024 * 1024;
  const form = new FormData();
  form.set('chat_id', chatId);
  if (caption) form.set('caption', caption);
  form.set(asPhoto ? 'photo' : 'document', new Blob([new Uint8Array(data)], { type: file.content_type }), file.file_name);
  let res: Response;
  try {
    res = await fetch(`${config.telegram.apiUrl}/bot${token}/${asPhoto ? 'sendPhoto' : 'sendDocument'}`, { method: 'POST', body: form, signal: AbortSignal.timeout(60_000) });
  } catch (e) {
    throw new TelegramError(0, `Telegram could not be reached (${e instanceof Error ? e.message : String(e)})`);
  }
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: { message_id: number }; description?: string };
  if (!res.ok || !body.ok) throw new TelegramError(res.status, body.description ?? `Telegram answered ${res.status}`);
  return String(body.result!.message_id);
}

/** Storage keys of a channel's message files (deleted from storage after the channel itself is deleted). */
export async function channelStorageKeys(db: Db, channelId: number): Promise<string[]> {
  const rows = await q<{ storage_key: string }>(sql`SELECT mf.storage_key FROM message_files mf JOIN messages m ON m.id = mf.message_id
    JOIN conversations cv ON cv.id = m.conversation_id WHERE cv.channel_id = ${channelId} AND mf.storage_key IS NOT NULL`, db);
  return rows.map((r) => r.storage_key);
}
