import { q, sql, type Db } from '../db/index.ts';
import { emit } from './events.ts';
import type { Ctx } from './context.ts';

type Changes = Record<string, [unknown, unknown]>;

const norm = (v: unknown) => (v instanceof Date ? v.toISOString() : v === undefined ? null : v);

/** Compute {field: [old, new]} for keys present in `next`. */
export function diff(prev: Record<string, unknown>, next: Record<string, unknown>): Changes {
  const out: Changes = {};
  for (const k of Object.keys(next)) {
    const a = norm(prev[k]);
    const b = norm(next[k]);
    if (JSON.stringify(a) !== JSON.stringify(b)) out[k] = [a, b];
  }
  return out;
}

export async function audit(
  db: Db, ctx: Ctx, entityType: string, entityId: number, action: string,
  changes: Record<string, unknown> = {}, actorType: 'user' | 'automation' | 'system' = ctx.roleName === 'system' ? 'automation' : 'user',
): Promise<void> {
  await q(sql`INSERT INTO audit_events (workspace_id, entity_type, entity_id, action, changes, actor_type, actor_id)
              VALUES (${ctx.workspaceId}, ${entityType}, ${entityId}, ${action}, ${JSON.stringify(changes)}, ${actorType},
                      ${actorType === 'user' ? ctx.userId : null})`, db);
  // Field changes on deals and leads feed "When a field changes" automation rules.
  if (action === 'updated' && (entityType === 'deal' || entityType === 'lead')) {
    const fields = changedFields(changes);
    if (fields.length) await emit(db, ctx.workspaceId, `${entityType}.field_changed`, entityType, entityId, { fields }, ctx.depth ?? 0);
  }
}

/** Field names in an audit change set: columns as-is, custom fields as custom.<key>; bookkeeping keys dropped. */
export function changedFields(changes: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(changes)) {
    if (k.startsWith('_') || ['methods', 'contacts', 'lineItems', 'version', 'updated_by'].includes(k)) continue;
    if (k === 'custom' && Array.isArray(v)) {
      const [a, b] = v as [Record<string, unknown> | null, Record<string, unknown> | null];
      for (const key of new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])) {
        if (JSON.stringify(a?.[key] ?? null) !== JSON.stringify(b?.[key] ?? null)) out.push(`custom.${key}`);
      }
    } else if (k.startsWith('custom.')) out.push(k);
    else out.push(k);
  }
  return out;
}
