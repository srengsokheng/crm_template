/** Settings → Channels (admins): connect website chat and Telegram bots. */
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { channelCreateSchema, channelUpdateSchema } from '@crm/shared';
import { q, q1, sql, tx } from '../db/index.ts';
import { audit } from '../lib/audit.ts';
import { conflict, notFound } from '../lib/errors.ts';
import { ctxOf, noContent } from '../lib/http.ts';
import { requireAdmin } from '../lib/permissions.ts';
import { camel } from '../lib/records.ts';
import { sealSecret, openSecret } from '../lib/secrets.ts';
import { parse } from '../lib/validate.ts';
import type { ChannelRow } from '../inbox/store.ts';
import { connectBot, disconnectBot } from '../inbox/telegram.ts';
import { channelStorageKeys } from '../inbox/files.ts';
import { files } from '../lib/files.ts';

/** What the API shows of a channel: never the token or the webhook secret. */
function publicChannel(c: ChannelRow & { conversation_count?: number; created_at?: Date }) {
  const cfg = c.config as Record<string, unknown>;
  return camel({
    id: c.id, kind: c.kind, name: c.name, status: c.status, last_error: c.last_error ?? null, public_key: c.public_key,
    created_at: c.created_at, conversation_count: c.conversation_count ?? 0,
    config: c.kind === 'webchat'
      ? { greeting: cfg.greeting, color: cfg.color, allowedOrigins: cfg.allowedOrigins ?? [] }
      : { username: cfg.username, botName: cfg.botName, mode: cfg.mode },
  });
}

export async function channelRoutes(app: FastifyInstance) {
  app.get('/channels', async (req) => {
    const ctx = ctxOf(req);
    requireAdmin(ctx);
    const rows = await q<ChannelRow>(sql`SELECT ch.*, (SELECT count(*)::int FROM conversations cv WHERE cv.channel_id = ch.id) AS conversation_count
      FROM channels ch WHERE ch.workspace_id = ${ctx.workspaceId} ORDER BY ch.created_at`);
    return { data: rows.map(publicChannel) };
  });

  app.post('/channels', async (req, reply) => {
    const ctx = ctxOf(req);
    requireAdmin(ctx);
    const body = parse(channelCreateSchema, req.body);
    const publicKey = randomBytes(16).toString('hex');
    if (body.kind === 'webchat') {
      const row = await tx(async (db) => {
        const r = await q1<ChannelRow>(sql`INSERT INTO channels (workspace_id, kind, name, public_key, config, created_by)
          VALUES (${ctx.workspaceId}, 'webchat', ${body.name}, ${publicKey},
            ${JSON.stringify({ greeting: body.greeting, color: body.color, allowedOrigins: body.allowedOrigins })}, ${ctx.userId}) RETURNING *`, db);
        await audit(db, ctx, 'channel', r!.id, 'created', { kind: 'webchat', name: body.name });
        return r!;
      });
      return reply.code(201).send(publicChannel(row));
    }
    const sealed = sealSecret(body.token); // fails early (503) when the server can't store credentials
    const botId = body.token.split(':')[0];
    const dup = await q1(sql`SELECT 1 FROM channels WHERE workspace_id = ${ctx.workspaceId} AND kind = 'telegram_bot' AND config->>'botId' = ${botId}`);
    if (dup) throw conflict('This bot is already connected');
    const bot = await connectBot(body.token, publicKey);
    const row = await tx(async (db) => {
      const r = await q1<ChannelRow>(sql`INSERT INTO channels (workspace_id, kind, name, public_key, config, secret, webhook_secret, created_by)
        VALUES (${ctx.workspaceId}, 'telegram_bot', ${body.name || (bot.username ? `@${bot.username}` : bot.botName)}, ${publicKey},
          ${JSON.stringify({ botId, username: bot.username, botName: bot.botName, mode: bot.mode, offset: 0 })}, ${sealed}, ${bot.webhookSecret}, ${ctx.userId})
        RETURNING *`, db);
      await audit(db, ctx, 'channel', r!.id, 'created', { kind: 'telegram_bot', name: r!.name });
      return r!;
    });
    return reply.code(201).send(publicChannel(row));
  });

  app.patch<{ Params: { id: string } }>('/channels/:id', async (req) => {
    const ctx = ctxOf(req);
    requireAdmin(ctx);
    const body = parse(channelUpdateSchema, req.body);
    const c = await q1<ChannelRow>(sql`SELECT * FROM channels WHERE id = ${Number(req.params.id)} AND workspace_id = ${ctx.workspaceId}`);
    if (!c) throw notFound('Channel');
    let status = body.status ?? (c.status === 'disabled' ? 'disabled' : c.status);
    const cfg: Record<string, unknown> = {};
    let webhookSecret = c.webhook_secret;
    if (c.kind === 'webchat') {
      if (body.greeting !== undefined) cfg.greeting = body.greeting;
      if (body.color !== undefined) cfg.color = body.color;
      if (body.allowedOrigins !== undefined) cfg.allowedOrigins = body.allowedOrigins;
    } else if (body.status === 'active' && c.status !== 'active') {
      // Re-enabling (or recovering from an error): set delivery up again with the stored token.
      const bot = await connectBot(openSecret(c.secret!), c.public_key);
      Object.assign(cfg, { username: bot.username, botName: bot.botName, mode: bot.mode });
      webhookSecret = bot.webhookSecret;
      status = 'active';
    } else if (body.status === 'disabled' && c.status !== 'disabled') {
      await disconnectBot(c);
    }
    return tx(async (db) => {
      const r = await q1<ChannelRow>(sql`UPDATE channels SET name = ${body.name ?? c.name}, status = ${status},
          last_error = ${status === 'error' ? c.last_error : null},
          config = config || ${JSON.stringify(cfg)}::jsonb, webhook_secret = ${webhookSecret}
        WHERE id = ${c.id} RETURNING *`, db);
      await audit(db, ctx, 'channel', c.id, 'updated', { ...body });
      return publicChannel(r!);
    });
  });

  /** Deletes the channel and all its conversations and messages. */
  app.delete<{ Params: { id: string } }>('/channels/:id', async (req, reply) => {
    const ctx = ctxOf(req);
    requireAdmin(ctx);
    const c = await q1<ChannelRow>(sql`SELECT * FROM channels WHERE id = ${Number(req.params.id)} AND workspace_id = ${ctx.workspaceId}`);
    if (!c) throw notFound('Channel');
    if (c.kind === 'telegram_bot') await disconnectBot(c);
    const keys = await tx(async (db) => {
      const k = await channelStorageKeys(db, c.id);
      await q(sql`DELETE FROM channels WHERE id = ${c.id}`, db);
      await audit(db, ctx, 'channel', c.id, 'deleted', { kind: c.kind, name: c.name });
      return k;
    });
    // After commit: a leftover file is harmless, a missing one is not.
    for (const k of keys) await files().remove(k).catch(() => {});
    return noContent(reply);
  });

}
