import type { PermissionAction, PermissionEntity, Scope } from '@crm/shared';
import { raw, sql, type Fragment } from '../db/index.ts';
import { forbidden } from './errors.ts';
import type { Ctx } from './context.ts';

export function scopeOf(ctx: Ctx, entity: PermissionEntity, action: PermissionAction): Scope {
  if (ctx.isAdmin) return 'all';
  return ctx.grants[entity]?.[action] ?? 'none';
}

export function requireAny(ctx: Ctx, entity: PermissionEntity, action: PermissionAction): Scope {
  const s = scopeOf(ctx, entity, action);
  if (s === 'none') throw forbidden();
  return s;
}

export function requireAdmin(ctx: Ctx): void {
  if (!ctx.isAdmin) throw forbidden('Only workspace admins can change settings');
}

/**
 * SQL predicate limiting rows to the caller's scope.
 * own → owner is me; team → owner in my teams; all → everything except other people's private records.
 */
export function scopeWhere(ctx: Ctx, entity: PermissionEntity, action: PermissionAction, alias: string, ownerCol = 'owner_id'): Fragment {
  const base = ownerScopeWhere(ctx, entity, action, alias, ownerCol);
  if ((entity === 'deal' || entity === 'lead') && ctx.blockedPipelineIds?.length) return sql`(${base} AND ${pipelineAllowed(ctx, alias)})`;
  return base;
}

/** SQL: the record (alias) is not in a pipeline the user's role is blocked from. */
export function pipelineAllowed(ctx: Ctx, alias: string): Fragment {
  if (!ctx.blockedPipelineIds?.length) return sql`TRUE`;
  return sql`NOT (${raw(`${alias}.pipeline_id`)} = ANY(${ctx.blockedPipelineIds}))`;
}

function ownerScopeWhere(ctx: Ctx, entity: PermissionEntity, action: PermissionAction, alias: string, ownerCol: string): Fragment {
  const s = scopeOf(ctx, entity, action);
  const owner = raw(`${alias}.${ownerCol}`);
  const vis = raw(`${alias}.visibility`);
  if (ctx.isAdmin) return sql`TRUE`;
  switch (s) {
    case 'all': return entity === 'product' || entity === 'activity' ? sql`TRUE` : sql`(${vis} = 'shared' OR ${owner} = ${ctx.userId})`;
    case 'team': return sql`${owner} = ANY(${ctx.teamUserIds})`;
    case 'own': return sql`${owner} = ${ctx.userId}`;
    default: return sql`FALSE`;
  }
}

export function canOnRecord(ctx: Ctx, entity: PermissionEntity, action: PermissionAction, row: { owner_id?: number | null; visibility?: string; pipeline_id?: number | null }): boolean {
  if (ctx.isAdmin) return true;
  if ((entity === 'deal' || entity === 'lead') && row.pipeline_id != null && ctx.blockedPipelineIds?.includes(Number(row.pipeline_id))) return false;
  const s = scopeOf(ctx, entity, action);
  const owner = row.owner_id ?? null;
  if (s === 'all') return row.visibility !== 'private' || owner === ctx.userId;
  if (s === 'team') return owner !== null && ctx.teamUserIds.includes(owner);
  if (s === 'own') return owner === ctx.userId;
  return false;
}

export function assertOnRecord(ctx: Ctx, entity: PermissionEntity, action: PermissionAction, row: { owner_id?: number | null; visibility?: string; pipeline_id?: number | null }): void {
  if (!canOnRecord(ctx, entity, action, row)) throw forbidden();
}

/** Throws when the user's role may not use this pipeline. */
export function assertPipelineAllowed(ctx: Ctx, pipelineId: number): void {
  if (ctx.blockedPipelineIds?.includes(Number(pipelineId))) throw forbidden('Your role does not have access to this pipeline');
}

/** Grants summary sent to the web app so it can hide actions the user cannot take. */
export function permissionSummary(ctx: Ctx): Record<string, Record<string, Scope>> {
  const entities: PermissionEntity[] = ['lead', 'deal', 'contact', 'company', 'product', 'activity', 'conversation'];
  const actions: PermissionAction[] = ['view', 'create', 'edit', 'delete', 'export', 'import'];
  const out: Record<string, Record<string, Scope>> = {};
  for (const e of entities) { out[e] = {}; for (const a of actions) out[e][a] = scopeOf(ctx, e, a); }
  return out;
}

/**
 * Inbox conversations are scoped by assignee rather than owner: own → assigned to me, team → assigned to someone in my
 * teams, all → everything. Unassigned conversations are in every scope so anyone may pick them up.
 */
export function conversationScopeWhere(ctx: Ctx, action: PermissionAction, alias: string): Fragment {
  const s = scopeOf(ctx, 'conversation', action);
  const a = raw(`${alias}.assignee_id`);
  if (s === 'all') return sql`TRUE`;
  if (s === 'team') return sql`(${a} IS NULL OR ${a} = ANY(${ctx.teamUserIds}))`;
  if (s === 'own') return sql`(${a} IS NULL OR ${a} = ${ctx.userId})`;
  return sql`FALSE`;
}
export function canOnConversation(ctx: Ctx, action: PermissionAction, row: { assignee_id: number | null }): boolean {
  const s = scopeOf(ctx, 'conversation', action);
  const a = row.assignee_id === null ? null : Number(row.assignee_id);
  if (s === 'all') return true;
  if (s === 'none') return false;
  if (a === null) return true;
  return s === 'team' ? ctx.teamUserIds.includes(a) : a === ctx.userId;
}
