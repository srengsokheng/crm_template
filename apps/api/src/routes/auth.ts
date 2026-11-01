import type { FastifyInstance, FastifyReply } from 'fastify';
import { acceptInviteSchema, loginSchema, signupSchema } from '@crm/shared';
import { config } from '../config.ts';
import { pool, q, q1, sql, tx } from '../db/index.ts';
import { createSession, destroySession, hashPassword, SESSION_COOKIE, sha256, verifyPassword } from '../lib/auth.ts';
import { createWorkspaceDefaults } from '../lib/bootstrap.ts';
import { AppError, badRequest } from '../lib/errors.ts';
import { ctxOf } from '../lib/http.ts';
import { permissionSummary } from '../lib/permissions.ts';
import { parse } from '../lib/validate.ts';

function setCookie(reply: FastifyReply, token: string) {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: 'lax', secure: config.isProd, path: '/', maxAge: config.sessionDays * 86400,
  });
}

const limit = { config: { rateLimit: { max: config.isTest ? 1000 : 10, timeWindow: '1 minute' } } };

export async function authRoutes(app: FastifyInstance) {
  app.post('/auth/signup', limit, async (req, reply) => {
    const body = parse(signupSchema, req.body);
    const exists = await q1(sql`SELECT 1 FROM users WHERE email = ${body.email}`);
    if (exists) throw badRequest('An account with this email already exists', { email: 'Already registered — sign in instead' });
    const passwordHash = await hashPassword(body.password);
    const token = await tx(async (db) => {
      const ws = await q1<{ id: number }>(sql`INSERT INTO workspaces (name) VALUES (${body.workspaceName}) RETURNING id`, db);
      const adminRole = await createWorkspaceDefaults(db, ws!.id);
      const user = await q1<{ id: number }>(sql`INSERT INTO users (email, password_hash, name, last_login_at)
        VALUES (${body.email}, ${passwordHash}, ${body.name}, now()) RETURNING id`, db);
      await q(sql`INSERT INTO memberships (workspace_id, user_id, role_id) VALUES (${ws!.id}, ${user!.id}, ${adminRole})`, db);
      return createSession(db, user!.id, ws!.id, req.headers['user-agent']);
    });
    setCookie(reply, token);
    return reply.code(201).send({ ok: true });
  });

  app.post('/auth/login', limit, async (req, reply) => {
    const body = parse(loginSchema, req.body);
    const user = await q1<{ id: number; password_hash: string | null; is_active: boolean }>(
      sql`SELECT id, password_hash, is_active FROM users WHERE email = ${body.email}`);
    const ok = user?.password_hash ? await verifyPassword(user.password_hash, body.password) : false;
    if (!user || !ok || !user.is_active) throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
    const m = await q1<{ workspace_id: number }>(sql`SELECT workspace_id FROM memberships
      WHERE user_id = ${user.id} AND status = 'active' ORDER BY created_at LIMIT 1`);
    if (!m) throw new AppError(403, 'NO_WORKSPACE', 'Your access to this workspace has been disabled');
    await q(sql`UPDATE users SET last_login_at = now() WHERE id = ${user.id}`);
    const token = await createSession(pool, user.id, m.workspace_id, req.headers['user-agent']);
    setCookie(reply, token);
    return { ok: true };
  });

  app.post('/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await destroySession(token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/auth/me', async (req) => {
    const ctx = ctxOf(req);
    const ws = await q1<{ name: string; base_currency: string; settings: Record<string, unknown> }>(
      sql`SELECT name, base_currency, settings FROM workspaces WHERE id = ${ctx.workspaceId}`);
    return {
      user: { id: ctx.userId, name: ctx.userName, email: ctx.email },
      role: { id: ctx.roleId, name: ctx.roleName, isAdmin: ctx.isAdmin },
      workspace: { id: ctx.workspaceId, name: ws!.name, baseCurrency: ws!.base_currency, useLeads: ctx.useLeads },
      permissions: permissionSummary(ctx),
    };
  });

  app.get<{ Params: { token: string } }>('/auth/invite/:token', async (req) => {
    const row = await q1<{ email: string; name: string; workspace: string }>(sql`
      SELECT u.email, u.name, w.name AS workspace FROM memberships m
      JOIN users u ON u.id = m.user_id JOIN workspaces w ON w.id = m.workspace_id
      WHERE m.invite_token_hash = ${sha256(req.params.token)} AND m.status = 'invited'`);
    if (!row) throw new AppError(404, 'INVITE_INVALID', 'This invitation link is invalid or was already used');
    return row;
  });

  app.post('/auth/accept-invite', limit, async (req, reply) => {
    const body = parse(acceptInviteSchema, req.body);
    const m = await q1<{ workspace_id: number; user_id: number }>(sql`SELECT workspace_id, user_id FROM memberships
      WHERE invite_token_hash = ${sha256(body.token)} AND status = 'invited'`);
    if (!m) throw new AppError(404, 'INVITE_INVALID', 'This invitation link is invalid or was already used');
    const passwordHash = await hashPassword(body.password);
    const token = await tx(async (db) => {
      await q(sql`UPDATE users SET name = ${body.name}, password_hash = coalesce(password_hash, ${passwordHash}), last_login_at = now()
        WHERE id = ${m.user_id}`, db);
      await q(sql`UPDATE memberships SET status = 'active', invite_token_hash = NULL
        WHERE workspace_id = ${m.workspace_id} AND user_id = ${m.user_id}`, db);
      return createSession(db, m.user_id, m.workspace_id, req.headers['user-agent']);
    });
    setCookie(reply, token);
    return { ok: true };
  });
}
