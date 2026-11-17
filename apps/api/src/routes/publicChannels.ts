/**
 * Endpoints without a session: the website chat widget (called from customers' websites, so CORS-enabled and
 * rate-limited) and the Telegram webhook (authenticated by the secret header Telegram sends back).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { webchatMessageSchema } from '@crm/shared';
import { q, q1, sql, tx } from '../db/index.ts';
import { config } from '../config.ts';
import { AppError, badRequest, forbidden, notFound } from '../lib/errors.ts';
import { newStorageKey } from '../lib/files.ts';
import { scanBuffer } from '../lib/virusScan.ts';
import { camelAll } from '../lib/records.ts';
import { parse } from '../lib/validate.ts';
import { files } from '../lib/files.ts';
import { cleanFileName, cleanType, sendStoredFile } from './attachments.ts';
import { recordInbound, type ChannelRow } from '../inbox/store.ts';
import { channelByKey, ingestUpdate, type TgUpdate } from '../inbox/telegram.ts';
import { notifyTyping, subscribeVisitor } from '../inbox/events.ts';
import type { ServerResponse } from 'node:http';

type KeyParams = { Params: { key: string } };
const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');
const TOKEN = /^[A-Za-z0-9_-]{32,64}$/;

/** The visitor's conversation, from the token kept in their browser. */
async function visitorConversation(c: ChannelRow, token: unknown): Promise<{ id: number; title: string } | null> {
  const t = String(token ?? '');
  if (!TOKEN.test(t)) return null;
  return (await q1<{ id: number; title: string }>(sql`SELECT id, title FROM conversations WHERE channel_id = ${c.id} AND external_id = ${hashToken(t)}`)) ?? null;
}

/** CORS for the widget. When the channel lists allowed websites, other origins are refused. */
function cors(req: FastifyRequest, reply: FastifyReply, c: ChannelRow | null) {
  const origin = req.headers.origin;
  const allowed = (c?.config.allowedOrigins as string[] | undefined) ?? [];
  reply.header('access-control-allow-origin', origin && allowed.length ? origin : '*');
  reply.header('vary', 'Origin');
  reply.header('access-control-allow-methods', 'GET, POST, OPTIONS');
  reply.header('access-control-allow-headers', 'content-type, x-requested-with, x-file-type');
  reply.header('access-control-max-age', '600');
  reply.header('cross-origin-resource-policy', 'cross-origin');
  if (c && origin && allowed.length && !allowed.some((a) => a.toLowerCase() === origin.toLowerCase())) {
    throw forbidden('This website is not allowed to use this chat');
  }
}

async function webchat(req: FastifyRequest<KeyParams>, reply: FastifyReply): Promise<ChannelRow> {
  const c = await channelByKey(req.params.key);
  const ok = c && c.kind === 'webchat' && c.status === 'active';
  cors(req, reply, ok ? c : null);
  if (!ok) throw notFound('Chat');
  return c;
}

/** Messages the visitor sees: theirs and the team's replies (agents shown by first name). */
async function visitorMessages(conversationId: number) {
  const rows = await q(sql`SELECT * FROM (
      SELECT m.id, m.direction, m.body, m.created_at, CASE WHEN m.direction = 'out' THEN split_part(coalesce(u.name, ''), ' ', 1) END AS agent,
        (SELECT coalesce(json_agg(json_build_object('id', f.id, 'fileName', f.file_name, 'contentType', f.content_type, 'sizeBytes', f.size_bytes) ORDER BY f.id), '[]'::json)
          FROM message_files f WHERE f.message_id = m.id AND f.status = 'stored') AS files
      FROM messages m LEFT JOIN users u ON u.id = m.author_id
      WHERE m.conversation_id = ${conversationId} AND (m.direction = 'in' OR m.status = 'sent') ORDER BY m.id DESC LIMIT 100
    ) t ORDER BY id`);
  return camelAll(rows);
}

export const VISITOR_MAX_BYTES = Math.min(config.files.maxBytes, 5 * 1024 * 1024);
export const VISITOR_DAILY_FILES = 20;

/** The file's real type from its first bytes (only the types visitors may send); null otherwise. */
export function sniffType(b: Buffer): string | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (b.length >= 5 && b.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}

export async function publicChannelRoutes(app: FastifyInstance) {
  // Raw uploads from the widget are only accepted by this plugin's routes.
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: VISITOR_MAX_BYTES }, (_req, body, done) => done(null, body));
  app.options<KeyParams>('/public/webchat/:key', async (req, reply) => { cors(req, reply, await channelByKey(req.params.key)); return reply.code(204).send(); });
  app.options<KeyParams>('/public/webchat/:key/messages', async (req, reply) => { cors(req, reply, await channelByKey(req.params.key)); return reply.code(204).send(); });
  app.options<KeyParams>('/public/webchat/:key/files', async (req, reply) => { cors(req, reply, await channelByKey(req.params.key)); return reply.code(204).send(); });
  app.options<KeyParams>('/public/webchat/:key/typing', async (req, reply) => { cors(req, reply, await channelByKey(req.params.key)); return reply.code(204).send(); });

  /**
   * Live updates for the visitor's open chat (server-sent events): "messages" when their conversation changes (they
   * then fetch it as usual) and "typing" while a team member writes a reply. Ends after 30 minutes; the widget
   * reconnects while the chat is open. Bounded per conversation and per process.
   */
  const visitorStreams = new Set<ServerResponse>();
  app.addHook('preClose', async () => { for (const s of visitorStreams) s.end(); visitorStreams.clear(); });
  app.get<KeyParams & { Querystring: { token?: string } }>('/public/webchat/:key/events', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const c = await webchat(req, reply);
    const conv = await visitorConversation(c, req.query.token);
    if (!conv) throw notFound('Chat');
    const res = reply.raw;
    const unsubscribe = await subscribeVisitor(conv.id, (event, name) => {
      res.write(event === 'messages' ? 'event: messages\ndata: {}\n\n' : `event: typing\ndata: ${JSON.stringify({ name: name ?? '' })}\n\n`);
    });
    if (!unsubscribe) throw new AppError(429, 'RATE_LIMITED', 'Too many open chats; updates are checked every few seconds instead.');
    reply.hijack();
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no',
      ...Object.fromEntries(Object.entries(reply.getHeaders()).filter(([k]) => k.startsWith('access-control-') || k === 'vary' || k === 'cross-origin-resource-policy')),
    });
    res.write('retry: 5000\n\n: connected\n\n');
    visitorStreams.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    const expire = setTimeout(() => res.end(), 30 * 60_000);
    res.on('close', () => { clearInterval(ping); clearTimeout(expire); unsubscribe(); visitorStreams.delete(res); });
  });

  /** The visitor is typing (the widget sends it at most every few seconds); the team sees it in the Inbox. */
  app.post<KeyParams>('/public/webchat/:key/typing', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const c = await webchat(req, reply);
    const conv = await visitorConversation(c, (req.body as { token?: unknown } | null)?.token);
    if (!conv) throw notFound('Chat');
    await notifyTyping(conv.id, 'customer', conv.title);
    return reply.code(204).send();
  });

  /** Widget settings. */
  app.get<KeyParams>('/public/webchat/:key', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const c = await webchat(req, reply);
    return { name: c.name, greeting: c.config.greeting ?? '', color: c.config.color ?? '#4f46e5' };
  });

  /** The visitor's conversation (token from their first message, kept in their browser). */
  app.get<KeyParams & { Querystring: { token?: string } }>('/public/webchat/:key/messages', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const c = await webchat(req, reply);
    const token = String(req.query.token ?? '');
    if (!/^[A-Za-z0-9_-]{32,64}$/.test(token)) return { messages: [] };
    const conv = await q1<{ id: number }>(sql`SELECT id FROM conversations WHERE channel_id = ${c.id} AND external_id = ${hashToken(token)}`);
    return { messages: conv ? await visitorMessages(conv.id) : [] };
  });

  app.post<KeyParams>('/public/webchat/:key/messages', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const c = await webchat(req, reply);
    const body = parse(webchatMessageSchema, req.body);
    const token = body.token ?? randomBytes(24).toString('base64url');
    const chatId = hashToken(token);
    const r = await tx((db) => recordInbound(db, {
      channel: c, chatId, kind: 'direct',
      title: body.name || body.email || `Website visitor ${chatId.slice(0, 4).toUpperCase()}`,
      profile: { name: body.name, email: body.email },
      messageId: null, senderName: body.name ?? '', body: body.body,
    }));
    // A name given in a later message replaces the placeholder title.
    if (r && body.name) await q(sql`UPDATE conversations SET title = ${body.name} WHERE id = ${r.conversationId} AND title LIKE 'Website visitor %'`);
    return reply.code(201).send({ token, messages: r ? await visitorMessages(r.conversationId) : [] });
  });

  /**
   * A visitor sends a file (raw bytes, ?token=&fileName=, X-File-Type). Only images and PDFs whose content matches the
   * type, up to VISITOR_MAX_BYTES, VISITOR_DAILY_FILES per conversation a day, 10 a minute per address; virus-scanned
   * when ClamAV is configured. Without a token, it starts the conversation like a first message would.
   */
  app.post<KeyParams & { Querystring: { token?: string; fileName?: string } }>('/public/webchat/:key/files',
    { bodyLimit: VISITOR_MAX_BYTES, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
      const c = await webchat(req, reply);
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw badRequest('Send the file as application/octet-stream');
      const data = req.body as Buffer;
      const fileName = cleanFileName(String(req.query.fileName ?? ''));
      const contentType = sniffType(data);
      if (!contentType || contentType !== cleanType(req.headers['x-file-type'])) {
        throw new AppError(415, 'FILE_TYPE', 'Only images (PNG, JPEG, GIF, WebP) and PDF files can be sent here.');
      }
      if (req.query.token !== undefined && !/^[A-Za-z0-9_-]{32,64}$/.test(String(req.query.token))) throw badRequest('Invalid chat token');
      const token = req.query.token ? String(req.query.token) : randomBytes(24).toString('base64url');
      const chatId = hashToken(token);
      const recent = await q1<{ n: number }>(sql`SELECT count(*)::int AS n FROM message_files f JOIN messages m ON m.id = f.message_id
        JOIN conversations cv ON cv.id = m.conversation_id
        WHERE cv.channel_id = ${c.id} AND cv.external_id = ${chatId} AND m.direction = 'in' AND f.created_at > now() - interval '1 day'`);
      if ((recent?.n ?? 0) >= VISITOR_DAILY_FILES) throw new AppError(429, 'RATE_LIMITED', 'You have sent the maximum number of files for today.');
      if (config.files.clamav.host) {
        let verdict;
        try { verdict = await scanBuffer(data, config.files.clamav); } catch { throw new AppError(503, 'SCANNER_UNAVAILABLE', 'Files can’t be checked right now. Please try again later.'); }
        if (!verdict.clean) throw new AppError(422, 'FILE_INFECTED', 'This file was flagged by the virus scanner and was not sent.');
      }
      const key = newStorageKey(c.workspace_id);
      const r = await tx(async (db) => {
        const label = contentType.startsWith('image/') ? '[Photo]' : `[File: ${fileName}]`;
        const rec = await recordInbound(db, {
          channel: c, chatId, kind: 'direct', title: `Website visitor ${chatId.slice(0, 4).toUpperCase()}`, profile: {},
          messageId: null, senderName: '', body: label,
        });
        if (!rec) return null;
        await q(sql`INSERT INTO message_files (workspace_id, message_id, file_name, content_type, size_bytes, status, storage_key)
          VALUES (${c.workspace_id}, ${rec.messageId}, ${fileName}, ${contentType}, ${data.length}, 'stored', ${key})`, db);
        await files().put(key, data); // inside the transaction: if storage fails, nothing is recorded
        return rec;
      });
      return reply.code(201).send({ token, messages: r ? await visitorMessages(r.conversationId) : [] });
    });

  /** A file in the visitor's conversation, theirs or the team's (the visitor's token proves it's theirs). */
  app.get<KeyParams & { Params: { key: string; id: string }; Querystring: { token?: string; inline?: string } }>('/public/webchat/:key/files/:id',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
      const c = await webchat(req, reply);
      const token = String(req.query.token ?? '');
      if (!/^[A-Za-z0-9_-]{32,64}$/.test(token)) throw notFound('File');
      const f = await q1<{ file_name: string; content_type: string; storage_key: string }>(sql`
        SELECT f.file_name, f.content_type, f.storage_key FROM message_files f JOIN messages m ON m.id = f.message_id
        JOIN conversations cv ON cv.id = m.conversation_id
        WHERE f.id = ${Number(req.params.id) || 0} AND f.status = 'stored' AND cv.channel_id = ${c.id} AND cv.external_id = ${hashToken(token)}`);
      const data = f ? await files().get(f.storage_key) : null;
      if (!f || !data) throw notFound('File');
      return sendStoredFile(reply, f, data, req.query.inline === '1');
    });

  /** Telegram pushes bot updates here (only when APP_URL is https; see inbox/telegram.ts). */
  app.post<KeyParams>('/hooks/telegram/:key', async (req) => {
    const c = await channelByKey(req.params.key);
    if (!c || c.kind !== 'telegram_bot') throw notFound('Channel');
    const got = Buffer.from(String(req.headers['x-telegram-bot-api-secret-token'] ?? ''));
    const want = Buffer.from(c.webhook_secret ?? '');
    if (!want.length || got.length !== want.length || !timingSafeEqual(got, want)) throw new AppError(401, 'UNAUTHENTICATED', 'Bad webhook secret');
    if (c.status !== 'active') return { ok: true }; // disabled: accept and drop, so Telegram stops retrying
    await tx((db) => ingestUpdate(db, c, req.body as TgUpdate));
    return { ok: true };
  });
}
