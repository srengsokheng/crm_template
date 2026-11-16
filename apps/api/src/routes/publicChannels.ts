/**
 * Endpoints without a session: the website chat widget (called from customers' websites, so CORS-enabled and
 * rate-limited) and the Telegram webhook (authenticated by the secret header Telegram sends back).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { webchatMessageSchema } from '@crm/shared';
import { q, q1, sql, tx } from '../db/index.ts';
import { AppError, forbidden, notFound } from '../lib/errors.ts';
import { camelAll } from '../lib/records.ts';
import { parse } from '../lib/validate.ts';
import { files } from '../lib/files.ts';
import { sendStoredFile } from './attachments.ts';
import { recordInbound, type ChannelRow } from '../inbox/store.ts';
import { channelByKey, ingestUpdate, type TgUpdate } from '../inbox/telegram.ts';

type KeyParams = { Params: { key: string } };
const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

/** CORS for the widget. When the channel lists allowed websites, other origins are refused. */
function cors(req: FastifyRequest, reply: FastifyReply, c: ChannelRow | null) {
  const origin = req.headers.origin;
  const allowed = (c?.config.allowedOrigins as string[] | undefined) ?? [];
  reply.header('access-control-allow-origin', origin && allowed.length ? origin : '*');
  reply.header('vary', 'Origin');
  reply.header('access-control-allow-methods', 'GET, POST, OPTIONS');
  reply.header('access-control-allow-headers', 'content-type, x-requested-with');
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

export async function publicChannelRoutes(app: FastifyInstance) {
  app.options<KeyParams>('/public/webchat/:key', async (req, reply) => { cors(req, reply, await channelByKey(req.params.key)); return reply.code(204).send(); });
  app.options<KeyParams>('/public/webchat/:key/messages', async (req, reply) => { cors(req, reply, await channelByKey(req.params.key)); return reply.code(204).send(); });

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

  /** A file the team sent in the visitor's conversation (the visitor's token proves it's theirs). */
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
