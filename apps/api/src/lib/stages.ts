import { q, q1, sql, type Db } from '../db/index.ts';
import { audit } from './audit.ts';
import type { Ctx } from './context.ts';
import { badRequest, notFound } from './errors.ts';
import { emit } from './events.ts';

export interface MoveInput { stageId: number; custom?: Record<string, unknown>; lostReasonId?: number | null; lostNote?: string | null }

export interface StageRow { id: number; pipeline_id: number; name: string; kind: 'open' | 'won' | 'lost'; probability: number | null; entity_type: string; sort: number }

export async function getStage(db: Db, ctx: Ctx, stageId: number): Promise<StageRow> {
  const s = await q1<StageRow>(sql`SELECT s.id, s.pipeline_id, s.name, s.kind, s.probability, s.sort, p.entity_type FROM stages s
    JOIN pipelines p ON p.id = s.pipeline_id WHERE s.id = ${stageId} AND p.workspace_id = ${ctx.workspaceId}`, db);
  if (!s) throw notFound('Stage');
  return s;
}

export async function resolvePipelineStage(db: Db, ctx: Ctx, entity: 'lead' | 'deal', pipelineId?: number | null, stageId?: number | null): Promise<StageRow> {
  if (stageId) {
    const s = await getStage(db, ctx, stageId);
    if (s.entity_type !== entity) throw badRequest('Stage belongs to another kind of pipeline', { stageId: 'Invalid stage' });
    if (pipelineId && s.pipeline_id !== pipelineId) throw badRequest('Stage does not belong to this pipeline', { stageId: 'Invalid stage' });
    return s;
  }
  const p = pipelineId
    ? await q1<{ id: number }>(sql`SELECT id FROM pipelines WHERE id = ${pipelineId} AND workspace_id = ${ctx.workspaceId} AND entity_type = ${entity}`, db)
    : await q1<{ id: number }>(sql`SELECT id FROM pipelines WHERE workspace_id = ${ctx.workspaceId} AND entity_type = ${entity} ORDER BY is_default DESC, sort, id LIMIT 1`, db);
  if (!p) throw badRequest('Pipeline not found', { pipelineId: 'Invalid pipeline' });
  const s = await q1<StageRow>(sql`SELECT s.id, s.pipeline_id, s.name, s.kind, s.probability, s.sort, ${entity}::text AS entity_type FROM stages s
    WHERE s.pipeline_id = ${p.id} AND s.kind = 'open' ORDER BY s.sort, s.id LIMIT 1`, db);
  if (!s) throw badRequest('This pipeline has no open stages');
  return s;
}

export async function stageOfKind(db: Db, pipelineId: number, kind: 'won' | 'lost' | 'open'): Promise<StageRow | undefined> {
  return q1<StageRow>(sql`SELECT id, pipeline_id, name, kind, probability, sort, '' AS entity_type FROM stages
    WHERE pipeline_id = ${pipelineId} AND kind = ${kind} ORDER BY sort, id LIMIT 1`, db);
}

/** Write history, audit and (unless `emit: false`) the outbox event automation listens to. */
export async function recordStageChange(db: Db, ctx: Ctx, entity: 'lead' | 'deal', id: number, from: StageRow | null, to: StageRow, extra: Record<string, unknown> = {},
  opts: { emit?: boolean } = {}): Promise<void> {
  await q(sql`INSERT INTO stage_history (workspace_id, entity_type, entity_id, from_stage_id, to_stage_id, moved_by)
    VALUES (${ctx.workspaceId}, ${entity}, ${id}, ${from?.id ?? null}, ${to.id}, ${ctx.roleName === 'system' ? null : ctx.userId})`, db);
  const action = to.kind === 'won' ? (entity === 'lead' ? 'converted' : 'won') : to.kind === 'lost' ? (entity === 'lead' ? 'disqualified' : 'lost')
    : from && from.kind !== 'open' ? 'reopened' : 'stage_changed';
  await audit(db, ctx, entity, id, from ? action : 'created', { stage: [from?.name ?? null, to.name], ...extra });
  if (opts.emit === false) return; // e.g. CSV import with automation turned off
  await emit(db, ctx.workspaceId, `${entity}.stage_entered`, entity, id, { stageId: to.id, fromStageId: from?.id ?? null }, ctx.depth ?? 0);
}
