import { createHash, randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import type { PermissionAction, PermissionEntity, Scope } from '@crm/shared';
import { config } from '../config.ts';
import { q, q1, sql, type Db, pool } from '../db/index.ts';
import type { Ctx } from './context.ts';

export const SESSION_COOKIE = 'crm_session';

export const hashPassword = (pw: string) => hash(pw, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
export const verifyPassword = (h: string, pw: string) => verify(h, pw).catch(() => false);

export const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');

export async function createSession(db: Db, userId: number, workspaceId: number, userAgent?: string): Promise<string> {
  const token = newToken();
  const expires = new Date(Date.now() + config.sessionDays * 86400_000);
  await q(sql`INSERT INTO sessions (id_hash, user_id, workspace_id, expires_at, user_agent)
              VALUES (${sha256(token)}, ${userId}, ${workspaceId}, ${expires}, ${userAgent?.slice(0, 300) ?? null})`, db);
  return token;
}

export async function destroySession(token: string): Promise<void> {
  await q(sql`DELETE FROM sessions WHERE id_hash = ${sha256(token)}`);
}

export async function loadContext(token: string): Promise<Ctx | null> {
  const row = await q1<{
    user_id: number; workspace_id: number; name: string; email: string; role_id: number; role_name: string;
    is_admin: boolean; base_currency: string; settings: { useLeads?: boolean };
  }>(sql`
    SELECT s.user_id, s.workspace_id, u.name, u.email, m.role_id, r.name AS role_name, r.is_admin,
           w.base_currency, w.settings
    FROM sessions s
    JOIN users u ON u.id = s.user_id AND u.is_active
    JOIN memberships m ON m.workspace_id = s.workspace_id AND m.user_id = s.user_id AND m.status = 'active'
    JOIN roles r ON r.id = m.role_id
    JOIN workspaces w ON w.id = s.workspace_id
    WHERE s.id_hash = ${sha256(token)} AND s.expires_at > now()`);
  if (!row) return null;
  return buildCtx(row);
}

export async function buildCtx(row: {
  user_id: number; workspace_id: number; name: string; email: string; role_id: number; role_name: string;
  is_admin: boolean; base_currency: string; settings: { useLeads?: boolean };
}, db: Db = pool): Promise<Ctx> {
  const grantsRows = await q<{ entity: PermissionEntity; action: PermissionAction; scope: Scope }>(
    sql`SELECT entity, action, scope FROM role_grants WHERE role_id = ${row.role_id}`, db);
  const grants: Ctx['grants'] = {};
  for (const g of grantsRows) (grants[g.entity] ??= {})[g.action] = g.scope;
  const team = await q<{ user_id: number }>(sql`
    SELECT DISTINCT tm2.user_id FROM team_members tm1
    JOIN team_members tm2 ON tm2.team_id = tm1.team_id
    JOIN teams t ON t.id = tm1.team_id AND t.workspace_id = ${row.workspace_id}
    WHERE tm1.user_id = ${row.user_id}`, db);
  const teamUserIds = Array.from(new Set([row.user_id, ...team.map((t) => t.user_id)]));
  return {
    userId: row.user_id, workspaceId: row.workspace_id, userName: row.name, email: row.email,
    roleId: row.role_id, roleName: row.role_name, isAdmin: row.is_admin, grants, teamUserIds,
    baseCurrency: row.base_currency, useLeads: row.settings?.useLeads !== false,
  };
}

/** Context for background work done on behalf of a user (e.g. a CSV import). Null if they lost access to the workspace. */
export async function ctxForUser(workspaceId: number, userId: number, db: Db = pool): Promise<Ctx | null> {
  const row = await q1<Parameters<typeof buildCtx>[0]>(sql`
    SELECT m.user_id, m.workspace_id, u.name, u.email, m.role_id, r.name AS role_name, r.is_admin, w.base_currency, w.settings
    FROM memberships m
    JOIN users u ON u.id = m.user_id AND u.is_active
    JOIN roles r ON r.id = m.role_id
    JOIN workspaces w ON w.id = m.workspace_id
    WHERE m.workspace_id = ${workspaceId} AND m.user_id = ${userId} AND m.status = 'active'`, db);
  return row ? buildCtx(row, db) : null;
}
