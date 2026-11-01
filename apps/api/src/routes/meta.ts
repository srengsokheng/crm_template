import type { FastifyInstance } from 'fastify';
import { q, q1, sql } from '../db/index.ts';
import { ctxOf } from '../lib/http.ts';
import { camelAll } from '../lib/records.ts';

export async function metaRoutes(app: FastifyInstance) {
  app.get('/health', async () => {
    await q1(sql`SELECT 1`);
    return { ok: true };
  });

  /** Reference data the web app needs everywhere (cached client-side). */
  app.get('/meta', async (req) => {
    const ctx = ctxOf(req);
    const ws = ctx.workspaceId;
    const [users, pipelines, stages, dictionaries, fields, teams, categories] = await Promise.all([
      q(sql`SELECT u.id, u.name, u.email, m.status, m.role_id, r.name AS role_name FROM memberships m
            JOIN users u ON u.id = m.user_id JOIN roles r ON r.id = m.role_id
            WHERE m.workspace_id = ${ws} ORDER BY u.name`),
      q(sql`SELECT id, entity_type, name, sort, is_default FROM pipelines WHERE workspace_id = ${ws} ORDER BY entity_type, sort, id`),
      q(sql`SELECT s.id, s.pipeline_id, s.name, s.color, s.sort, s.kind, s.probability, s.rot_days FROM stages s
            JOIN pipelines p ON p.id = s.pipeline_id WHERE p.workspace_id = ${ws} ORDER BY s.pipeline_id, s.sort, s.id`),
      q(sql`SELECT id, kind, label, sort, is_active FROM dictionary_items WHERE workspace_id = ${ws} ORDER BY kind, sort, id`),
      q(sql`SELECT id, entity_type, key, label, type, options, required, required_stage_ids, help_text, sort, is_active
            FROM field_definitions WHERE workspace_id = ${ws} ORDER BY entity_type, sort, id`),
      q(sql`SELECT t.id, t.name, coalesce(array_agg(tm.user_id) FILTER (WHERE tm.user_id IS NOT NULL), '{}') AS member_ids
            FROM teams t LEFT JOIN team_members tm ON tm.team_id = t.id WHERE t.workspace_id = ${ws} GROUP BY t.id ORDER BY t.name`),
      q(sql`SELECT id, name, sort FROM product_categories WHERE workspace_id = ${ws} ORDER BY sort, name`),
    ]);
    const stageList = camelAll<{ pipelineId: number }>(stages);
    return {
      users: camelAll(users),
      pipelines: camelAll<{ id: number }>(pipelines).map((p) => ({ ...p, stages: stageList.filter((s) => s.pipelineId === p.id) })),
      dictionaries: camelAll(dictionaries),
      fields: camelAll(fields),
      teams: camelAll(teams),
      productCategories: camelAll(categories),
    };
  });
}
