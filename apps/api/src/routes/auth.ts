import type { FastifyInstance, FastifyReply } from 'fastify';
import { DEFAULT_WORKING_HOURS, type WorkingHours, acceptInviteSchema, forgotPasswordSchema, loginSchema, preferencesSchema, resetPasswordSchema, signupSchema } from '@crm/shared';
import { config } from '../config.ts';
import { pool, q, q1, sql, tx } from '../db/index.ts';
import { createSession, destroySession, hashPassword, newToken, SESSION_COOKIE, sha256, verifyPassword } from '../lib/auth.ts';
import { queueMail, resetMail } from '../lib/mailer.ts';
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

  // ─────────────── Password reset ───────────────
  // Always the same answer, so the form can't be used to find out which emails have accounts.
  const resetLimit = { config: { rateLimit: { max: config.isTest ? 1000 : 5, timeWindow: '15 minutes' } } };
  app.post('/auth/forgot-password', resetLimit, async (req) => {
    const body = parse(forgotPasswordSchema, req.body);
    await tx(async (db) => {
      const user = await q1<{ id: number; name: string; email: string }>(sql`SELECT u.id, u.name, u.email FROM users u
        WHERE u.email = ${body.email} AND u.is_active AND u.password_hash IS NOT NULL
          AND EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id AND m.status = 'active')`, db);
      if (!user) return;
      // At most 3 open requests per hour per account; older unused links stop working when a new one is sent.
      const recent = await q1<{ n: number }>(sql`SELECT count(*)::int AS n FROM password_resets
        WHERE user_id = ${user.id} AND created_at > now() - interval '1 hour'`, db);
      if ((recent?.n ?? 0) >= 3) return;
      await q(sql`UPDATE password_resets SET used_at = now() WHERE user_id = ${user.id} AND used_at IS NULL`, db);
      const token = newToken();
      await q(sql`INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (${user.id}, ${sha256(token)}, now() + interval '1 hour')`, db);
      await queueMail(resetMail({ to: user.email, name: user.name, url: `${config.appUrl}/reset-password/${token}` }), db);
    });
    req.log.info('password reset requested');
    return { ok: true };
  });

  app.get<{ Params: { token: string } }>('/auth/reset/:token', async (req) => {
    const r = await q1<{ email: string }>(sql`SELECT u.email FROM password_resets pr JOIN users u ON u.id = pr.user_id
      WHERE pr.token_hash = ${sha256(req.params.token)} AND pr.used_at IS NULL AND pr.expires_at > now() AND u.is_active`);
    if (!r) throw new AppError(404, 'NOT_FOUND', 'This reset link is invalid or has expired. Ask for a new one.');
    return { email: r.email };
  });

  app.post('/auth/reset-password', limit, async (req) => {
    const body = parse(resetPasswordSchema, req.body);
    const passwordHash = await hashPassword(body.password);
    await tx(async (db) => {
      const r = await q1<{ id: number; user_id: number }>(sql`SELECT pr.id, pr.user_id FROM password_resets pr JOIN users u ON u.id = pr.user_id
        WHERE pr.token_hash = ${sha256(body.token)} AND pr.used_at IS NULL AND pr.expires_at > now() AND u.is_active FOR UPDATE OF pr`, db);
      if (!r) throw new AppError(404, 'NOT_FOUND', 'This reset link is invalid or has expired. Ask for a new one.');
      await q(sql`UPDATE users SET password_hash = ${passwordHash} WHERE id = ${r.user_id}`, db);
      await q(sql`UPDATE password_resets SET used_at = now() WHERE user_id = ${r.user_id} AND used_at IS NULL`, db);
      // Signed out everywhere: whoever knew the old password loses access.
      await q(sql`DELETE FROM sessions WHERE user_id = ${r.user_id}`, db);
    });
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
    const ws = await q1<{ name: string; base_currency: string; timezone: string; settings: Record<string, unknown> }>(
      sql`SELECT name, base_currency, timezone, settings FROM workspaces WHERE id = ${ctx.workspaceId}`);
    const m = await q1<{ email_reminders: boolean }>(sql`SELECT email_reminders FROM memberships WHERE workspace_id = ${ctx.workspaceId} AND user_id = ${ctx.userId}`);
    return {
      preferences: { emailReminders: m?.email_reminders ?? true },
      user: { id: ctx.userId, name: ctx.userName, email: ctx.email },
      role: { id: ctx.roleId, name: ctx.roleName, isAdmin: ctx.isAdmin },
      workspace: { id: ctx.workspaceId, name: ws!.name, baseCurrency: ws!.base_currency, useLeads: ctx.useLeads, timezone: ws!.timezone,
        workingHours: (ws!.settings.workingHours as WorkingHours | undefined) ?? DEFAULT_WORKING_HOURS },
      permissions: permissionSummary(ctx),
      fieldRules: ctx.isAdmin ? {} : (ctx.fieldRules ?? {}),
    };
  });

  /** Personal settings for the current workspace. */
  app.patch('/auth/preferences', async (req) => {
    const ctx = ctxOf(req);
    const body = parse(preferencesSchema, req.body);
    if (body.emailReminders !== undefined) {
      await q(sql`UPDATE memberships SET email_reminders = ${body.emailReminders} WHERE workspace_id = ${ctx.workspaceId} AND user_id = ${ctx.userId}`);
    }
    return { emailReminders: body.emailReminders };
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
