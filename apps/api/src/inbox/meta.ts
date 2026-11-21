/**
 * Facebook Messenger, Instagram and WhatsApp through Meta's official APIs (Graph API + webhooks).
 *
 * What the business needs: a Meta app (developers.facebook.com) with the Messenger, Instagram or WhatsApp product,
 * a long-lived access token (Page token, or a system-user token for WhatsApp) and the app secret. The admin pastes
 * them in Settings → Channels; they're stored encrypted (SECRETS_KEY). In the app's Webhooks settings they enter the
 * callback URL and verify token shown on the channel and subscribe to "messages".
 *
 * Webhooks are set per Meta app, so one callback URL may carry events for several channels: each event is routed by
 * its Page / Instagram account / phone number id, only to channels of the same workspace, after the signature
 * (X-Hub-Signature-256, HMAC-SHA256 of the raw body with the app secret) checked out.
 *
 * Meta only delivers free-form replies within 24 hours of the customer's last message; later replies fail with an
 * explanation (WhatsApp templates are not supported yet).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isMetaKind, type MetaKind } from '@crm/shared';
import { config } from '../config.ts';
import { pool, q1, sql, tx } from '../db/index.ts';
import { AppError } from '../lib/errors.ts';
import { files, newStorageKey } from '../lib/files.ts';
import { openSecret, sealSecret } from '../lib/secrets.ts';
import { scanBuffer } from '../lib/virusScan.ts';
import { notifyInbox } from './events.ts';
import { maxFileBytes, queueIncomingFile, setStatus, type FileRef } from './files.ts';
import { recordInbound, type ChannelRow } from './store.ts';

export class MetaError extends Error {
  status: number; code: number | null; subcode: number | null;
  constructor(status: number, message: string, code: number | null = null, subcode: number | null = null) {
    super(message); this.status = status; this.code = code; this.subcode = subcode;
  }
}

interface Credentials { accessToken: string; appSecret: string }
export const sealCredentials = (c: Credentials) => sealSecret(JSON.stringify(c));
export function credentialsOf(c: { secret: string | null }): Credentials {
  if (!c.secret) throw new MetaError(0, 'This channel has no credentials');
  return JSON.parse(openSecret(c.secret)) as Credentials;
}

/** Calls the Graph API with the token in the Authorization header (never in the URL, so it stays out of logs). */
export async function graph<T>(token: string, method: 'GET' | 'POST', path: string, body?: Record<string, unknown> | FormData): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${config.meta.graphUrl}/${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}) },
      body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(body instanceof FormData ? 60_000 : 15_000),
    });
  } catch (e) {
    throw new MetaError(0, `Meta could not be reached (${e instanceof Error ? e.message : String(e)})`);
  }
  const data = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: number; error_subcode?: number } } & T;
  if (!res.ok || data.error) {
    const err = data.error ?? {};
    throw new MetaError(res.status, err.message ?? `Meta answered ${res.status}`, err.code ?? null, err.error_subcode ?? null);
  }
  return data;
}

// ---------------------------------------------------------------------------------------------------------------
// Connecting

export const metaWebhookUrl = (c: { public_key: string }) => `${config.appUrl.replace(/\/$/, '')}/api/v1/hooks/meta/${c.public_key}`;

/**
 * Checks the token against the account and returns what to show for it. Throws 422 with an explanation when Meta
 * refuses (wrong token, wrong id, missing permission).
 */
export async function verifyMetaAccount(kind: MetaKind, accountId: string, token: string): Promise<{ accountName: string }> {
  try {
    if (kind === 'messenger') {
      const p = await graph<{ name?: string }>(token, 'GET', `${accountId}?fields=id,name`);
      // Without this, the Page's messages aren't sent to the app's webhook.
      await graph(token, 'POST', `${accountId}/subscribed_apps`, { subscribed_fields: ['messages'] });
      return { accountName: p.name ?? accountId };
    }
    if (kind === 'instagram') {
      const a = await graph<{ username?: string; name?: string }>(token, 'GET', `${accountId}?fields=id,username,name`);
      return { accountName: a.username ? `@${a.username}` : (a.name ?? accountId) };
    }
    const n = await graph<{ display_phone_number?: string; verified_name?: string }>(token, 'GET', `${accountId}?fields=id,display_phone_number,verified_name`);
    return { accountName: [n.verified_name, n.display_phone_number].filter(Boolean).join(' · ') || accountId };
  } catch (e) {
    if (!(e instanceof MetaError)) throw e;
    const msg = e.code === 190 ? 'Meta did not accept this access token (it may have expired). Create a new long-lived token and paste it again.'
      : e.code === 100 || e.status === 404 ? `Meta couldn’t find this ${kind === 'whatsapp' ? 'phone number ID' : kind === 'instagram' ? 'Instagram account ID' : 'Page ID'} with this token. Check both come from the same account.`
      : e.code === 10 || e.code === 200 || e.status === 403 ? `The token is missing a permission: ${PERMISSIONS[kind]}.`
      : e.status === 0 ? e.message : `Meta refused: ${e.message}`;
    throw new AppError(422, 'META_ACCOUNT', msg);
  }
}

export const PERMISSIONS: Record<MetaKind, string> = {
  messenger: 'pages_messaging and pages_manage_metadata',
  instagram: 'instagram_basic and instagram_manage_messages',
  whatsapp: 'whatsapp_business_messaging',
};

export const newVerifyToken = () => randomBytes(24).toString('hex');

// ---------------------------------------------------------------------------------------------------------------
// Webhooks

/** True when the raw body carries a valid X-Hub-Signature-256 for this app secret. */
export function validSignature(raw: Buffer, header: unknown, appSecret: string): boolean {
  const got = String(header ?? '');
  if (!got.startsWith('sha256=')) return false;
  const want = Buffer.from(`sha256=${createHmac('sha256', appSecret).update(raw).digest('hex')}`);
  const g = Buffer.from(got);
  return g.length === want.length && timingSafeEqual(g, want);
}

/** One incoming message, normalised across the three platforms. */
export interface MetaInbound {
  kind: MetaKind;
  accountId: string;
  chatId: string; // PSID, Instagram-scoped id, or WhatsApp number (wa_id)
  messageId: string;
  body: string;
  senderName: string | null; // WhatsApp sends the profile name; Messenger/Instagram need a lookup
  phone?: string;
  file: (FileRef & { source: 'url' | 'media' }) | null;
}
export interface MetaStatus { accountId: string; messageId: string; error: string }

type Attachment = { type?: string; payload?: { url?: string; title?: string; sticker_id?: number } };
interface MessagingEvent {
  sender?: { id?: string }; recipient?: { id?: string };
  message?: { mid?: string; text?: string; is_echo?: boolean; is_deleted?: boolean; is_unsupported?: boolean; attachments?: Attachment[] };
}
interface WaMessage {
  from?: string; id?: string; type?: string; text?: { body?: string };
  image?: WaMedia; video?: WaMedia; audio?: WaMedia; voice?: WaMedia; document?: WaMedia & { filename?: string }; sticker?: WaMedia;
  location?: { latitude?: number; longitude?: number; name?: string };
  contacts?: { name?: { formatted_name?: string }; phones?: { phone?: string }[] }[];
  interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } };
  button?: { text?: string }; reaction?: { emoji?: string };
}
interface WaMedia { id?: string; mime_type?: string; caption?: string }
export interface MetaPayload {
  object?: string;
  entry?: {
    id?: string; messaging?: MessagingEvent[];
    changes?: { field?: string; value?: {
      metadata?: { phone_number_id?: string };
      contacts?: { wa_id?: string; profile?: { name?: string } }[];
      messages?: WaMessage[];
      statuses?: { id?: string; status?: string; errors?: { code?: number; title?: string; message?: string }[] }[];
    } }[];
  }[];
}

const LABEL: Record<string, string> = { image: '[Photo]', video: '[Video]', audio: '[Audio]', file: '[File]', sticker: '[Sticker]', location: '[Location]' };
const GUESS: Record<string, string> = { image: 'image/jpeg', video: 'video/mp4', audio: 'audio/mpeg', file: 'application/octet-stream' };
const EXT: Record<string, string> = { image: 'jpg', video: 'mp4', audio: 'mp3', file: 'bin' };

/** Parses a webhook body into messages and failed-delivery reports. Unknown events are skipped. */
export function parseMetaPayload(p: MetaPayload): { messages: MetaInbound[]; statuses: MetaStatus[] } {
  const messages: MetaInbound[] = [];
  const statuses: MetaStatus[] = [];
  const kind: MetaKind | null = p.object === 'page' ? 'messenger' : p.object === 'instagram' ? 'instagram' : p.object === 'whatsapp_business_account' ? 'whatsapp' : null;
  if (!kind) return { messages, statuses };
  for (const e of p.entry ?? []) {
    if (kind !== 'whatsapp') {
      for (const ev of e.messaging ?? []) {
        const m = ev.message;
        // Echoes are our own (or the Page inbox's) outgoing messages; deleted/unsupported ones have nothing to show.
        if (!m?.mid || m.is_echo || m.is_deleted || !ev.sender?.id || !e.id) continue;
        const atts = m.attachments ?? [];
        const labels = atts.map((a) => LABEL[a.type ?? ''] ?? '[Attachment]');
        const body = [...labels, m.text ?? ''].filter(Boolean).join(' ') || (m.is_unsupported ? '[Unsupported message]' : '');
        if (!body) continue;
        const a = atts.find((x) => x.payload?.url && GUESS[x.type ?? '']);
        const short = m.mid.slice(-8).replace(/[^A-Za-z0-9]/g, '');
        messages.push({
          kind, accountId: e.id, chatId: ev.sender.id, messageId: m.mid, body, senderName: null,
          file: a ? { source: 'url', fileId: a.payload!.url!, fileName: a.payload?.title || `${a.type}-${short}.${EXT[a.type!]}`, contentType: GUESS[a.type!], size: null } : null,
        });
      }
      continue;
    }
    for (const ch of e.changes ?? []) {
      const v = ch.value;
      const accountId = v?.metadata?.phone_number_id;
      if (ch.field !== 'messages' || !v || !accountId) continue;
      for (const s of v.statuses ?? []) {
        if (s.status === 'failed' && s.id) {
          const err = s.errors?.[0];
          statuses.push({ accountId, messageId: s.id, error: waError(err?.code ?? null, err?.message || err?.title || 'WhatsApp could not deliver the message') });
        }
      }
      for (const m of v.messages ?? []) {
        if (!m.id || !m.from) continue;
        const name = v.contacts?.find((c) => c.wa_id === m.from)?.profile?.name ?? null;
        const { body, file } = describeWa(m);
        if (!body) continue;
        messages.push({ kind, accountId, chatId: m.from, messageId: m.id, body, senderName: name, phone: `+${m.from}`, file });
      }
    }
  }
  return { messages, statuses };
}

function describeWa(m: WaMessage): { body: string; file: MetaInbound['file'] } {
  const cap = (x?: { caption?: string }) => (x?.caption ? ` ${x.caption}` : '');
  const media = (x: WaMedia | undefined, kind: string, name: string): MetaInbound['file'] =>
    x?.id ? { source: 'media', fileId: x.id, fileName: name, contentType: x.mime_type?.split(';')[0] ?? GUESS[kind], size: null } : null;
  switch (m.type) {
    case 'text': return { body: m.text?.body ?? '', file: null };
    case 'image': return { body: `[Photo]${cap(m.image)}`, file: media(m.image, 'image', `photo-${m.id!.slice(-8)}.jpg`) };
    case 'video': return { body: `[Video]${cap(m.video)}`, file: media(m.video, 'video', `video-${m.id!.slice(-8)}.mp4`) };
    case 'audio': case 'voice': return { body: '[Audio]', file: media(m.audio ?? m.voice, 'audio', `audio-${m.id!.slice(-8)}.ogg`) };
    case 'document': return { body: `[File: ${m.document?.filename ?? 'document'}]${cap(m.document)}`, file: media(m.document, 'file', m.document?.filename ?? `file-${m.id!.slice(-8)}`) };
    case 'sticker': return { body: '[Sticker]', file: null };
    case 'location': return { body: `[Location: ${m.location?.name ? `${m.location.name}, ` : ''}${m.location?.latitude}, ${m.location?.longitude}]`, file: null };
    case 'contacts': return { body: `[Contact: ${(m.contacts ?? []).map((c) => [c.name?.formatted_name, c.phones?.[0]?.phone].filter(Boolean).join(' ')).join('; ')}]`, file: null };
    case 'interactive': return { body: m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? '[Reply]', file: null };
    case 'button': return { body: m.button?.text ?? '[Button]', file: null };
    case 'reaction': return { body: m.reaction?.emoji ? `[Reaction ${m.reaction.emoji}]` : '', file: null };
    default: return { body: '[Unsupported message]', file: null };
  }
}

/** The channel a webhook event belongs to: same workspace as the channel whose URL was called, same account. */
async function channelFor(workspaceId: number, kind: MetaKind, accountId: string): Promise<ChannelRow | null> {
  return (await q1<ChannelRow>(sql`SELECT * FROM channels WHERE workspace_id = ${workspaceId} AND kind = ${kind}
    AND config->>'accountId' = ${accountId} ORDER BY id LIMIT 1`)) ?? null;
}

/** Name of a Messenger/Instagram user (needs the Page/Instagram permission; falls back when Meta won't say). */
async function profileName(c: ChannelRow, userId: string): Promise<string | null> {
  try {
    const token = credentialsOf(c).accessToken;
    if (c.kind === 'messenger') {
      const p = await graph<{ first_name?: string; last_name?: string; name?: string }>(token, 'GET', `${userId}?fields=first_name,last_name`);
      return [p.first_name, p.last_name].filter(Boolean).join(' ') || p.name || null;
    }
    const p = await graph<{ name?: string; username?: string }>(token, 'GET', `${userId}?fields=name,username`);
    return p.name || (p.username ? `@${p.username}` : null);
  } catch { return null; }
}

const fallbackTitle = (m: MetaInbound) => m.kind === 'whatsapp' ? `+${m.chatId}` : `${m.kind === 'messenger' ? 'Messenger' : 'Instagram'} user ${m.chatId.slice(-4)}`;

/** Stores what a webhook delivered. Returns the number of new messages. */
export async function ingestMeta(keyChannel: ChannelRow, payload: MetaPayload): Promise<number> {
  const { messages, statuses } = parseMetaPayload(payload);
  let stored = 0;
  for (const m of messages) {
    const c = await channelFor(keyChannel.workspace_id, m.kind, m.accountId);
    if (!c || c.status !== 'active') continue;
    // A name lookup only for a new conversation (outside the transaction: it's a network call).
    const known = await q1(sql`SELECT 1 FROM conversations WHERE channel_id = ${c.id} AND external_id = ${m.chatId}`);
    const name = m.senderName ?? (known ? null : await profileName(c, m.chatId));
    const r = await tx(async (db) => {
      const rec = await recordInbound(db, {
        channel: c, chatId: m.chatId, kind: 'direct', title: name || fallbackTitle(m),
        profile: { name: name ?? undefined, phone: m.phone, platformId: m.chatId },
        messageId: m.messageId, senderName: name ?? '', body: m.body,
      });
      if (rec && m.file) await queueIncomingFile(db, c.workspace_id, rec.messageId, { ...m.file, fileId: `${m.file.source}:${m.file.fileId}` });
      return rec;
    });
    if (r) stored++;
  }
  for (const s of statuses) {
    const c = await channelFor(keyChannel.workspace_id, 'whatsapp', s.accountId);
    if (!c) continue;
    const r = await q1<{ conversation_id: number }>(sql`UPDATE messages m SET status = 'failed', error = ${s.error}
      FROM conversations cv WHERE cv.id = m.conversation_id AND cv.channel_id = ${c.id} AND m.direction = 'out' AND m.external_id = ${s.messageId}
      RETURNING m.conversation_id`);
    if (r) await notifyInbox(pool, r.conversation_id);
  }
  return stored;
}

// ---------------------------------------------------------------------------------------------------------------
// Sending

const WINDOW = 'Meta only delivers replies within 24 hours of the customer’s last message. Ask them to write again (for example by phone or email).';

// ---------------------------------------------------------------------------------------------------------------
// WhatsApp templates

export interface TemplateRef { name: string; language: string; params: string[] }
export interface Template { name: string; language: string; category: string; header: string | null; body: string; footer: string | null; params: number }

/** The {{1}}, {{2}}… blanks in a template text. */
export const blanks = (text: string) => new Set([...text.matchAll(/\{\{(\d+)\}\}/g)].map((m) => m[1])).size;
/** The template text with its blanks filled in, as the customer sees it. */
export function renderTemplate(t: Template, params: string[]): string {
  const fill = (s: string) => s.replace(/\{\{(\d+)\}\}/g, (_, n) => params[Number(n) - 1] ?? '');
  return [t.header, fill(t.body), t.footer].filter(Boolean).join('\n\n');
}

const templateCache = new Map<number, { at: number; data: Template[] }>();
/**
 * The business account's approved templates that the Inbox can send: text only, values only in the body (templates
 * with media headers or header/button values are left out). Cached for 2 minutes per channel.
 */
export async function listTemplates(c: ChannelRow): Promise<Template[]> {
  const hit = templateCache.get(c.id);
  if (hit && hit.at > Date.now() - 120_000) return hit.data;
  const waba = String(c.config.businessAccountId ?? '');
  if (!waba) throw new AppError(409, 'NO_WABA', 'Add the WhatsApp Business Account ID to this channel in Settings → Channels to use templates.');
  type Raw = { name: string; language: string; status: string; category?: string; components?: { type: string; format?: string; text?: string; buttons?: { url?: string }[] }[] };
  let raw: { data?: Raw[] };
  try {
    raw = await graph<{ data?: Raw[] }>(credentialsOf(c).accessToken, 'GET', `${waba}/message_templates?fields=name,language,status,category,components&status=APPROVED&limit=200`);
  } catch (e) {
    if (e instanceof MetaError && e.status !== 0 && e.status < 500) throw new AppError(422, 'META_TEMPLATES', e.code === 190 ? 'Meta no longer accepts this channel’s access token.' : `Meta refused to list the templates: ${e.message}`);
    throw e;
  }
  const data: Template[] = [];
  for (const t of raw.data ?? []) {
    if (t.status !== 'APPROVED') continue;
    const comp = (type: string) => t.components?.find((x) => x.type === type);
    const header = comp('HEADER');
    const body = comp('BODY')?.text ?? '';
    if (!body) continue;
    if (header && (header.format !== 'TEXT' || blanks(header.text ?? ''))) continue;
    if (comp('BUTTONS')?.buttons?.some((b) => b.url && blanks(b.url))) continue;
    data.push({ name: t.name, language: t.language, category: t.category ?? '', header: header?.text ?? null, body, footer: comp('FOOTER')?.text ?? null, params: blanks(body) });
  }
  data.sort((a, b) => a.name.localeCompare(b.name) || a.language.localeCompare(b.language));
  templateCache.set(c.id, { at: Date.now(), data });
  return data;
}
export const forgetTemplates = (channelId: number) => templateCache.delete(channelId);

/** Checks a WhatsApp Business Account ID with Meta. */
export async function verifyWaba(token: string, waba: string): Promise<void> {
  try { await graph(token, 'GET', `${waba}?fields=id,name`); }
  catch (e) {
    if (!(e instanceof MetaError)) throw e;
    throw new AppError(422, 'META_ACCOUNT', e.status === 0 ? e.message : 'Meta couldn’t find this WhatsApp Business Account ID with this token (WhatsApp Manager → Account tools, or API setup).');
  }
}

function waError(code: number | null, message: string): string {
  if (code === 132000) return 'The template’s blanks don’t match what WhatsApp expects. Check the template in WhatsApp Manager.';
  if (code === 132001) return 'This template doesn’t exist (any more) in this language. Pick another one.';
  if (code === 132015 || code === 132016) return 'WhatsApp paused or disabled this template because of its quality. Pick another one.';
  if (code === 131047) return `${WINDOW} After that, WhatsApp only delivers approved templates: use “Send a template”.`;
  if (code === 131026) return 'WhatsApp could not deliver the message (the number may not use WhatsApp, or has an old app).';
  return `WhatsApp refused the message: ${message}`;
}

/** Turns a refusal into a message for the team. Returns null for errors worth retrying (outage, rate limit). */
export function refusalText(kind: MetaKind, e: MetaError): string | null {
  if (e.status === 0 || e.status >= 500 || e.status === 429 || e.code === 4 || e.code === 613) return null;
  if (e.code === 190) return 'Meta no longer accepts this channel’s access token. An admin needs to update it in Settings → Channels.';
  if (kind === 'whatsapp') return waError(e.code, e.message);
  if (e.subcode === 2018278 || e.subcode === 2534022 || e.code === 10) return WINDOW;
  if (e.code === 551) return 'This person isn’t available on Messenger right now.';
  return `${kind === 'messenger' ? 'Messenger' : 'Instagram'} refused the message: ${e.message}`;
}

/** Text limits per message; longer replies are sent in parts. */
const TEXT_MAX: Record<MetaKind, number> = { messenger: 2000, instagram: 1000, whatsapp: 4096 };
export function splitText(text: string, max: number): string[] {
  const chars = [...text];
  const parts: string[] = [];
  for (let i = 0; i < chars.length; i += max) parts.push(chars.slice(i, i + max).join(''));
  return parts.length ? parts : [''];
}

function attachmentType(contentType: string): 'image' | 'video' | 'audio' | 'file' {
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('video/')) return 'video';
  if (contentType.startsWith('audio/')) return 'audio';
  return 'file';
}

/** Sends a reply (text, or a file with an optional caption, or a WhatsApp template). Returns the platform's id of the last message sent. */
export async function sendMeta(c: ChannelRow, chatId: string, text: string, file: { file_name: string; content_type: string; data: Buffer } | null, template: TemplateRef | null = null): Promise<string> {
  const kind = c.kind as MetaKind;
  const { accessToken } = credentialsOf(c);
  const accountId = String(c.config.accountId);
  let last = '';
  if (template) {
    if (kind !== 'whatsapp') throw new MetaError(400, 'Templates are only for WhatsApp');
    const r = await graph<{ messages: { id: string }[] }>(accessToken, 'POST', `${accountId}/messages`, {
      messaging_product: 'whatsapp', recipient_type: 'individual', to: chatId, type: 'template',
      template: { name: template.name, language: { code: template.language },
        components: template.params.length ? [{ type: 'body', parameters: template.params.map((p) => ({ type: 'text', text: p })) }] : [] },
    });
    return r.messages[0].id;
  }
  if (kind === 'whatsapp') {
    if (file) {
      const type = attachmentType(file.content_type) === 'file' ? 'document' : attachmentType(file.content_type);
      const form = new FormData();
      form.set('messaging_product', 'whatsapp');
      form.set('type', file.content_type);
      form.set('file', new Blob([new Uint8Array(file.data)], { type: file.content_type }), file.file_name);
      const up = await graph<{ id: string }>(accessToken, 'POST', `${accountId}/media`, form);
      const captioned = type !== 'audio' && text.length <= 1024;
      const media: Record<string, unknown> = { id: up.id, ...(captioned && text ? { caption: text } : {}), ...(type === 'document' ? { filename: file.file_name } : {}) };
      const r = await graph<{ messages: { id: string }[] }>(accessToken, 'POST', `${accountId}/messages`, { messaging_product: 'whatsapp', recipient_type: 'individual', to: chatId, type, [type]: media });
      last = r.messages[0].id;
      if (captioned || !text) return last;
    }
    for (const part of splitText(text, TEXT_MAX.whatsapp)) {
      const r = await graph<{ messages: { id: string }[] }>(accessToken, 'POST', `${accountId}/messages`, { messaging_product: 'whatsapp', recipient_type: 'individual', to: chatId, type: 'text', text: { body: part, preview_url: false } });
      last = r.messages[0].id;
    }
    return last;
  }
  // Messenger and Instagram: the Send API on the Page (Instagram messaging also goes through the linked Page's token).
  if (file) {
    const type = attachmentType(file.content_type);
    if (kind === 'instagram' && type === 'file') throw new MetaError(400, 'Instagram can only receive photos, videos and audio, not other files.');
    const form = new FormData();
    form.set('recipient', JSON.stringify({ id: chatId }));
    form.set('messaging_type', 'RESPONSE');
    form.set('message', JSON.stringify({ attachment: { type, payload: { is_reusable: false } } }));
    form.set('filedata', new Blob([new Uint8Array(file.data)], { type: file.content_type }), file.file_name);
    last = (await graph<{ message_id: string }>(accessToken, 'POST', 'me/messages', form)).message_id;
    if (!text) return last;
  }
  for (const part of splitText(text, TEXT_MAX[kind])) {
    last = (await graph<{ message_id: string }>(accessToken, 'POST', 'me/messages', { recipient: { id: chatId }, messaging_type: 'RESPONSE', message: { text: part } })).message_id;
  }
  return last;
}

const typingShown = new Map<number, number>();
/** "typing…" on Messenger and Instagram (at most every 4 s per conversation; failures don't matter). */
export function showMetaTyping(channelId: number, conversationId: number): void {
  const now = Date.now();
  if ((typingShown.get(conversationId) ?? 0) > now - 4000) return;
  typingShown.set(conversationId, now);
  if (typingShown.size > 5000) for (const [k, t] of typingShown) if (t < now - 10_000) typingShown.delete(k);
  void (async () => {
    const c = await q1<ChannelRow & { external_id: string }>(sql`SELECT ch.*, cv.external_id FROM channels ch
      JOIN conversations cv ON cv.channel_id = ch.id WHERE ch.id = ${channelId} AND cv.id = ${conversationId}`);
    if (!c || (c.kind !== 'messenger' && c.kind !== 'instagram')) return;
    await graph(credentialsOf(c).accessToken, 'POST', 'me/messages', { recipient: { id: c.external_id }, sender_action: 'typing_on' });
  })().catch(() => {});
}

// ---------------------------------------------------------------------------------------------------------------
// Incoming files ("url:<cdn url>" for Messenger/Instagram, "media:<id>" for WhatsApp)

/**
 * Incoming file URLs arrive in webhook payloads, which are signed with an app secret the workspace itself chose — so
 * they are not trusted: only Meta's CDN hosts over HTTPS (or the configured Graph API origin, used by tests) are
 * fetched, never internal addresses.
 */
const META_FILE_HOSTS = ['fbcdn.net', 'fbsbx.com', 'cdninstagram.com', 'facebook.com', 'whatsapp.net'];
export function metaFileUrlAllowed(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.username || u.password) return false;
  if (u.origin === new URL(config.meta.graphUrl).origin) return true;
  const h = u.hostname.toLowerCase();
  return u.protocol === 'https:' && !u.port && META_FILE_HOSTS.some((d) => h === d || h.endsWith(`.${d}`));
}

export async function fetchMetaFile(fileRowId: number, ch: ChannelRow, ref: string): Promise<void> {
  const { accessToken } = credentialsOf(ch);
  let url: string;
  let auth = false;
  if (ref.startsWith('media:')) {
    try {
      const info = await graph<{ url?: string; file_size?: number }>(accessToken, 'GET', ref.slice(6));
      if (!info.url) return setStatus(fileRowId, 'failed');
      if (info.file_size && info.file_size > maxFileBytes()) return setStatus(fileRowId, 'too_large', info.file_size);
      url = info.url;
      auth = true; // WhatsApp media URLs need the token too
    } catch (e) {
      if (e instanceof MetaError && e.status >= 400 && e.status < 500 && e.status !== 429) return setStatus(fileRowId, 'failed');
      throw e;
    }
  } else {
    url = ref.slice(4);
  }
  if (!metaFileUrlAllowed(url)) return setStatus(fileRowId, 'failed');
  // Redirects are followed by hand so every hop stays on Meta's hosts (the URL comes from a webhook payload).
  let res: Response | null = null;
  for (let hop = 0; hop < 4; hop++) {
    res = await fetch(url, { headers: auth ? { authorization: `Bearer ${accessToken}` } : {}, redirect: 'manual', signal: AbortSignal.timeout(60_000) });
    if (res.status < 300 || res.status >= 400) break;
    const next = res.headers.get('location');
    await res.body?.cancel();
    if (!next) return setStatus(fileRowId, 'failed');
    url = new URL(next, url).toString();
    if (!metaFileUrlAllowed(url) || hop === 3) return setStatus(fileRowId, 'failed');
  }
  if (!res) return setStatus(fileRowId, 'failed');
  if (res.status === 403 || res.status === 404 || res.status === 410) return setStatus(fileRowId, 'failed'); // link expired
  if (!res.ok) throw new Error(`Meta file download answered ${res.status}`);
  const size = Number(res.headers.get('content-length') ?? 0);
  if (size > maxFileBytes()) return setStatus(fileRowId, 'too_large', size);
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length > maxFileBytes()) return setStatus(fileRowId, 'too_large', data.length);
  if (config.files.clamav.host) {
    const verdict = await scanBuffer(data, config.files.clamav);
    if (!verdict.clean) return setStatus(fileRowId, 'blocked', data.length);
  }
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  const key = newStorageKey(ch.workspace_id);
  await files().put(key, data);
  const done = await q1<{ conversation_id: number }>(sql`UPDATE message_files mf SET status = 'stored', storage_key = ${key}, size_bytes = ${data.length},
      content_type = CASE WHEN ${/^[a-z]+\/[a-z0-9.+-]+$/.test(type) && type !== 'application/octet-stream'} THEN ${type.slice(0, 100)} ELSE mf.content_type END
    FROM messages m WHERE mf.id = ${fileRowId} AND mf.status = 'pending' AND m.id = mf.message_id RETURNING m.conversation_id`);
  if (!done) return files().remove(key);
  await notifyInbox(pool, done.conversation_id);
}

export const isMetaChannel = (c: { kind: string }) => isMetaKind(c.kind);
