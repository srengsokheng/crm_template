/** Your account → Telegram notifications: connect, see, disconnect (each person for themselves). */
import type { FastifyInstance } from 'fastify';
import { q, q1, sql } from '../db/index.ts';
import { AppError } from '../lib/errors.ts';
import { ctxOf } from '../lib/http.ts';
import { alertBot, startLink } from '../inbox/teamAlerts.ts';

export async function accountTelegramRoutes(app: FastifyInstance) {
  app.get('/account/telegram', async (req) => {
    const ctx = ctxOf(req);
    const bot = await alertBot(ctx.workspaceId);
    const link = await q1<{ tg_name: string; linked_at: Date }>(sql`SELECT tg_name, linked_at FROM user_telegram WHERE user_id = ${ctx.userId} AND workspace_id = ${ctx.workspaceId}`);
    return { available: !!bot, botUsername: bot ? String(bot.config.username) : null, linked: link ? { tgName: link.tg_name, linkedAt: link.linked_at } : null };
  });

  /** A one-time link (15 minutes) that opens the bot in Telegram and links this person's chat. */
  app.post('/account/telegram/link', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const ctx = ctxOf(req);
    const r = await startLink(ctx.workspaceId, ctx.userId);
    if (!r) throw new AppError(409, 'NO_BOT', 'This workspace has no Telegram bot yet. An admin can connect one in Settings → Channels.');
    return r;
  });

  app.delete('/account/telegram', async (req, reply) => {
    const ctx = ctxOf(req);
    await q(sql`DELETE FROM user_telegram WHERE user_id = ${ctx.userId} AND workspace_id = ${ctx.workspaceId}`);
    return reply.code(204).send();
  });
}
