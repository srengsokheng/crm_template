import { q, sql, type Db } from '../db/index.ts';

export type DomainEvent = 'deal.created' | 'deal.stage_entered' | 'deal.field_changed' | 'lead.created' | 'lead.stage_entered' | 'lead.field_changed';

export async function emit(
  db: Db, workspaceId: number, type: DomainEvent, entityType: 'deal' | 'lead', entityId: number,
  payload: Record<string, unknown> = {}, depth = 0,
): Promise<void> {
  await q(sql`INSERT INTO outbox_events (workspace_id, type, entity_type, entity_id, payload, depth)
              VALUES (${workspaceId}, ${type}, ${entityType}, ${entityId}, ${JSON.stringify(payload)}, ${depth})`, db);
}
