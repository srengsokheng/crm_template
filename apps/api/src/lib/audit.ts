import { q, sql, type Db } from '../db/index.ts';
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
}
