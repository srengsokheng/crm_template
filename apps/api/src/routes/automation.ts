import type { FastifyInstance } from 'fastify';
import { automationRuleSchema, automationRuleUpdateSchema, webhookSettingsSchema } from '@crm/shared';
import { q, q1, sql } from '../db/index.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { ctxOf } from '../lib/http.ts';
import type { Ctx } from '../lib/context.ts';
import { requireAdmin, requireAny } from '../lib/permissions.ts';
import { camel, camelAll } from '../lib/records.ts';
import { parse } from '../lib/validate.ts';
import { checkWebhookUrl, newWebhookSecret, normaliseHost } from '../lib/webhooks.ts';

type IdParams = { Params: { id: string } };

/** Built-in fields that can trigger "When a field changes" rules (audit change keys). */
export const TRIGGER_FIELDS: Record<'deal' | 'lead', string[]> = {
  deal: ['amount', 'title', 'owner_id', 'expected_close_date', 'probability', 'company_id', 'source_id', 'deal_type_id', 'visibility', 'description'],
  lead: ['amount', 'title', 'owner_id', 'source_id', 'company_name', 'first_name', 'last_name', 'visibility', 'description'],
};

async function validateRule(ctx: Ctx, r: { entityType?: string; pipelineId?: number; stageId?: number | null; action?: string; config?: Record<string, unknown>; trigger?: string; triggerField?: string | null }) {
  if (r.trigger === 'field_changed') {
    if (!r.triggerField) throw badRequest('Choose the field that triggers this rule', { triggerField: 'Required' });
    if (r.triggerField.startsWith('custom.')) {
      const f = await q1(sql`SELECT 1 FROM field_definitions WHERE workspace_id = ${ctx.workspaceId} AND entity_type = ${r.entityType ?? ''} AND key = ${r.triggerField.slice(7)}`);
      if (!f) throw badRequest('Unknown custom field', { triggerField: 'Invalid' });
    } else if (!TRIGGER_FIELDS[r.entityType as 'deal' | 'lead']?.includes(r.triggerField)) throw badRequest('This field cannot trigger rules', { triggerField: 'Invalid' });
    // A rule that changes the field it listens to would only trigger itself.
    const target = String(r.config?.field ?? '');
    const asColumn: Record<string, string> = { expectedCloseDate: 'expected_close_date', sourceId: 'source_id' };
    if (r.action === 'update_field' && (asColumn[target] ?? target) === r.triggerField) throw badRequest('A rule can’t change the field that triggers it');
  }
  if (r.pipelineId) {
    const p = await q1<{ entity_type: string }>(sql`SELECT entity_type FROM pipelines WHERE id = ${r.pipelineId} AND workspace_id = ${ctx.workspaceId}`);
    if (!p) throw badRequest('Pipeline not found', { pipelineId: 'Invalid' });
    if (r.entityType && p.entity_type !== r.entityType) throw badRequest('Pipeline type does not match', { pipelineId: 'Invalid' });
  }
  if (r.stageId) {
    const s = await q1(sql`SELECT 1 FROM stages WHERE id = ${r.stageId} AND pipeline_id = ${r.pipelineId ?? 0}`);
    if (!s) throw badRequest('Stage is not in this pipeline', { stageId: 'Invalid' });
  }
  if (r.trigger === 'stage_entered' && !r.stageId) throw badRequest('Choose the stage that triggers this rule', { stageId: 'Required' });
  const c = r.config ?? {};
  switch (r.action) {
    case 'create_activity': if (!c.subject) throw badRequest('Enter a subject for the activity', { 'config.subject': 'Required' }); break;
    case 'add_note': if (!c.text) throw badRequest('Enter the note text', { 'config.text': 'Required' }); break;
    case 'notify': if (!c.title && !c.message) throw badRequest('Enter a message', { 'config.message': 'Required' }); break;
    case 'update_field': if (!c.field) throw badRequest('Choose a field', { 'config.field': 'Required' }); break;
    case 'assign_owner':
      if (c.mode === 'round_robin' ? !c.teamId : !c.userId) throw badRequest('Choose who to assign', { 'config.userId': 'Required' });
      break;
    case 'webhook': {
      const ws = await q1<{ settings: { webhooks?: { allowedHosts?: string[] } } }>(sql`SELECT settings FROM workspaces WHERE id = ${ctx.workspaceId}`);
      try { checkWebhookUrl(String(c.url ?? ''), ws?.settings.webhooks?.allowedHosts ?? []); } catch (e) {
        throw badRequest((e as Error).message, { 'config.url': 'Invalid' });
      }
      break;
    }
    case 'move_stage': {
      const s = await q1(sql`SELECT 1 FROM stages WHERE id = ${Number(c.stageId ?? 0)} AND pipeline_id = ${r.pipelineId ?? 0}`);
      if (!s) throw badRequest('Choose a target stage in this pipeline', { 'config.stageId': 'Required' });
      if (Number(c.stageId) === r.stageId) throw badRequest('Target stage must differ from the trigger stage');
      break;
    }
  }
}

export async function automationRoutes(app: FastifyInstance) {
  // ── Webhook settings (admins): allow-list of hosts and the signing secret ──
  const loadHooks = async (workspaceId: number) => {
    const ws = await q1<{ settings: { webhooks?: { allowedHosts?: string[]; secret?: string } } }>(sql`SELECT settings FROM workspaces WHERE id = ${workspaceId}`);
    return ws?.settings.webhooks ?? {};
  };
  const saveHooks = (workspaceId: number, hooks: { allowedHosts: string[]; secret: string }) =>
    q(sql`UPDATE workspaces SET settings = settings || jsonb_build_object('webhooks', ${JSON.stringify(hooks)}::jsonb) WHERE id = ${workspaceId}`);
  app.get('/settings/webhooks', async (req) => {
    const ctx = ctxOf(req);
    requireAdmin(ctx);
    const h = await loadHooks(ctx.workspaceId);
    if (!h.secret) { h.secret = newWebhookSecret(); await saveHooks(ctx.workspaceId, { allowedHosts: h.allowedHosts ?? [], secret: h.secret }); }
    return { allowedHosts: h.allowedHosts ?? [], secret: h.secret };
  });
  app.put('/settings/webhooks', async (req) => {
    const ctx = ctxOf(req);
    requireAdmin(ctx);
    const body = parse(webhookSettingsSchema, req.body);
    const hosts: string[] = [];
    for (const raw of body.allowedHosts.filter((x) => x.trim())) {
      const h = normaliseHost(raw);
      if (!h) throw badRequest(`"${raw}" is not a host name (use e.g. hooks.example.com or *.example.com)`, { allowedHosts: 'Invalid host' });
      if (!hosts.includes(h)) hosts.push(h);
    }
    const cur = await loadHooks(ctx.workspaceId);
    await saveHooks(ctx.workspaceId, { allowedHosts: hosts, secret: cur.secret ?? newWebhookSecret() });
    return { allowedHosts: hosts };
  });
  app.post('/settings/webhooks/rotate-secret', async (req) => {
    const ctx = ctxOf(req);
    requireAdmin(ctx);
    const cur = await loadHooks(ctx.workspaceId);
    const secret = newWebhookSecret();
    await saveHooks(ctx.workspaceId, { allowedHosts: cur.allowedHosts ?? [], secret });
    return { secret };
  });

  app.get('/automation-rules', async (req) => {
    const ctx = ctxOf(req);
    const pipelineId = Number((req.query as { pipelineId?: string }).pipelineId) || undefined;
    const rows = await q(sql`SELECT r.*, (SELECT count(*)::int FROM automation_runs ar WHERE ar.rule_id = r.id AND ar.status = 'success') AS success_count,
        (SELECT count(*)::int FROM automation_runs ar WHERE ar.rule_id = r.id AND ar.status = 'failed') AS failed_count
      FROM automation_rules r WHERE r.workspace_id = ${ctx.workspaceId} ${pipelineId ? sql`AND r.pipeline_id = ${pipelineId}` : sql``}
      ORDER BY r.pipeline_id, r.stage_id NULLS FIRST, r.sort, r.id`);
    return { data: camelAll(rows) };
  });

  app.post('/automation-rules', async (req, reply) => {
    const ctx = ctxOf(req);
    requireAdmin(ctx);
    const body = parse(automationRuleSchema, req.body);
    await validateRule(ctx, body);
    const row = await q1(sql`INSERT INTO automation_rules (workspace_id, entity_type, pipeline_id, stage_id, trigger, trigger_field, business_hours, delay_minutes, conditions, action, config, is_enabled, created_by, sort)
      VALUES (${ctx.workspaceId}, ${body.entityType}, ${body.pipelineId}, ${body.stageId ?? null}, ${body.trigger},
              ${body.trigger === 'field_changed' ? body.triggerField ?? null : null}, ${body.businessHours}, ${body.delayMinutes},
              ${JSON.stringify(body.conditions)}::jsonb, ${body.action}, ${JSON.stringify(body.config)}::jsonb, ${body.isEnabled}, ${ctx.userId},
              (SELECT coalesce(max(sort),0)+1 FROM automation_rules WHERE workspace_id = ${ctx.workspaceId}))
      RETURNING *`);
    return reply.code(201).send(camel(row));
  });

  app.patch<IdParams>('/automation-rules/:id', async (req) => {
    const ctx = ctxOf(req);
    requireAdmin(ctx);
    const body = parse(automationRuleUpdateSchema, req.body);
    const id = Number(req.params.id);
    const existing = await q1<Record<string, unknown>>(sql`SELECT * FROM automation_rules WHERE id = ${id} AND workspace_id = ${ctx.workspaceId}`);
    if (!existing) throw notFound('Rule');
    const merged = { ...camel<Record<string, unknown>>(existing), ...body } as never;
    await validateRule(ctx, merged);
    const m = merged as Record<string, unknown>;
    const row = await q1(sql`UPDATE automation_rules SET stage_id = ${(m.stageId as number) ?? null}, trigger = ${m.trigger as string}, delay_minutes = ${m.delayMinutes as number},
      trigger_field = ${m.trigger === 'field_changed' ? (m.triggerField as string) ?? null : null}, business_hours = ${Boolean(m.businessHours)},
      conditions = ${JSON.stringify(m.conditions)}::jsonb, action = ${m.action as string}, config = ${JSON.stringify(m.config)}::jsonb, is_enabled = ${m.isEnabled as boolean}
      WHERE id = ${id} RETURNING *`);
    return camel(row);
  });

  app.delete<IdParams>('/automation-rules/:id', async (req, reply) => {
    const ctx = ctxOf(req);
    requireAdmin(ctx);
    await q(sql`DELETE FROM automation_rules WHERE id = ${Number(req.params.id)} AND workspace_id = ${ctx.workspaceId}`);
    return reply.code(204).send();
  });

  app.get<{ Params: { type: string; id: string } }>('/automation-runs/:type/:id', async (req) => {
    const ctx = ctxOf(req);
    const type = req.params.type === 'lead' ? 'lead' : 'deal';
    requireAny(ctx, type, 'view');
    const rows = await q(sql`SELECT ar.id, ar.status, ar.scheduled_for, ar.finished_at, ar.message, r.action, r.config
      FROM automation_runs ar LEFT JOIN automation_rules r ON r.id = ar.rule_id
      WHERE ar.workspace_id = ${ctx.workspaceId} AND ar.entity_type = ${type} AND ar.entity_id = ${Number(req.params.id)}
      ORDER BY ar.scheduled_for DESC LIMIT 100`);
    return { data: camelAll(rows) };
  });
}
