import type { FastifyInstance } from 'fastify';
import {
  dictionaryItemSchema, dictionaryUpdateSchema, fieldCreateSchema, fieldUpdateSchema, inviteSchema, memberUpdateSchema,
  pipelineCreateSchema, pipelineUpdateSchema, reorderSchema, roleCreateSchema, roleUpdateSchema, stageDeleteSchema, stageSchema,
  stageUpdateSchema, teamSchema, workspaceUpdateSchema,
} from '@crm/shared';
import { config } from '../config.ts';
import { q, q1, sql, tx } from '../db/index.ts';
import { newToken, sha256 } from '../lib/auth.ts';
import { createPipeline, setRoleGrants } from '../lib/bootstrap.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { ctxOf } from '../lib/http.ts';
import { requireAdmin } from '../lib/permissions.ts';
import { camel, camelAll } from '../lib/records.ts';
import { parse } from '../lib/validate.ts';

type IdParams = { Params: { id: string } };

export async function settingsRoutes(app: FastifyInstance) {
  // ─────────────── Workspace ───────────────
  app.patch('/workspace', async (req) => {
    const ctx = ctxOf(req);
    requireAdmin(ctx);
    const body = parse(workspaceUpdateSchema, req.body);
    const row = await q1(sql`UPDATE workspaces SET
        name = coalesce(${body.name ?? null}, name),
        base_currency = coalesce(${body.baseCurrency ?? null}, base_currency),
        settings = CASE WHEN ${body.useLeads ?? null}::boolean IS NULL THEN settings ELSE jsonb_set(settings, '{useLeads}', to_jsonb(${body.useLeads ?? null}::boolean)) END
      WHERE id = ${ctx.workspaceId} RETURNING id, name, base_currency, settings`);
    return camel(row);
  });

  // ─────────────── Pipelines & stages ───────────────
  app.post('/pipelines', async (req, reply) => {
    const ctx = ctxOf(req);
    requireAdmin(ctx);
    const body = parse(pipelineCreateSchema, req.body);
    const id = await tx(async (db) => {
      const sort = await q1<{ s: number }>(sql`SELECT coalesce(max(sort),0)+1 AS s FROM pipelines WHERE workspace_id = ${ctx.workspaceId} AND entity_type = ${body.entityType}`, db);
      const hasDefault = await q1(sql`SELECT 1 FROM pipelines WHERE workspace_id = ${ctx.workspaceId} AND entity_type = ${body.entityType} AND is_default`, db);
      return createPipeline(db, ctx.workspaceId, body.entityType, body.name, !hasDefault, sort!.s);
    });
    return reply.code(201).send({ id });
  });

  app.patch<IdParams>('/pipelines/:id', async (req) => {
    const ctx = ctxOf(req);
    requireAdmin(ctx);
    const body = parse(pipelineUpdateSchema, req.body);
    const id = Number(req.params.id);
    return tx(async (db) => {
      const p = await q1<{ entity_type: string }>(sql`SELECT entity_type FROM pipelines WHERE id = ${id} AND workspace_id = ${ctx.workspaceId}`, db);
      if (!p) throw notFound('Pipeline');
      if (body.isDefault) await q(sql`UPDATE pipelines SET is_default = false WHERE workspace_id = ${ctx.workspaceId} AND entity_type = ${p.entity_type}`, db);
      const row = await q1(sql`UPDATE pipelines SET name = coalesce(${body.name ?? null}, name),
        is_default = CASE WHEN ${body.isDefault ?? null}::boolean THEN true ELSE is_default END WHERE id = ${id} RETURNING *`, db);
      return camel(row);
    });
  });

  app.delete<IdParams>('/pipelines/:id', async (req, reply) => {
    const ctx = ctxOf(req);
    requireAdmin(ctx);
    const id = Number(req.params.id);
    const p = await q1<{ is_default: boolean; entity_type: string }>(sql`SELECT is_default, entity_type FROM pipelines WHERE id = ${id} AND workspace_id = ${ctx.workspaceId}`);
    if (!p) throw notFound('Pipeline');
    if (p.is_default) throw badRequest('The default pipeline cannot be deleted. Make another pipeline the default first.');
    const used = await q1<{ n: number }>(sql`SELECT ((SELECT count(*) FROM deals WHERE pipeline_id = ${id}) + (SELECT count(*) FROM leads WHERE pipeline_id = ${id}))::int AS n`);
    if (used!.n > 0) throw badRequest(`This pipeline still has ${used!.n} records (including deleted ones). Move them first.`);
    await q(sql`DELETE FROM pipelines WHERE id = ${id}`);
    return reply.code(204).send();
  });

  app.post<IdParams>('/pipelines/:id/stages', async (req, reply) => {
    const ctx = ctxOf(req);
    requireAdmin(ctx);
    const body = parse(stageSchema, req.body);
    const id = Number(req.params.id);
    const p = await q1(sql`SELECT 1 FROM pipelines WHERE id = ${id} AND workspace_id = ${ctx.workspaceId}`);
    if (!p) throw notFound('Pipeline');
    if (body.kind === 'won' && (await q1(sql`SELECT 1 FROM stages WHERE pipeline_id = ${id} AND kind = 'won'`))) throw badRequest('A pipeline can have only one won stage', { kind: 'Already has a won stage' });
    // New open stages go before the closed stages.
    const sort = body.kind === 'open'
      ? (await q1<{ s: number }>(sql`SELECT coalesce(max(sort) FILTER (WHERE kind = 'open'), -1) + 1 AS s FROM stages WHERE pipeline_id = ${id}`))!.s
      : (await q1<{ s: number }>(sql`SELECT coalesce(max(sort), -1) + 1 AS s FROM stages WHERE pipeline_id = ${id}`))!.s;
    await q(sql`UPDATE stages SET sort = sort + 1 WHERE pipeline_id = ${id} AND sort >= ${sort}`);
    const row = await q1(sql`INSERT INTO stages (pipeline_id, name, color, kind, probability, rot_days, sort)
      VALUES (${id}, ${body.name}, ${body.color}, ${body.kind}, ${body.probability ?? null}, ${body.rotDays ?? null}, ${sort}) RETURNING *`);
    return reply.code(201).send(camel(row));
  });

  app.patch<IdParams>('/stages/:id', async (req) => {
    const ctx = ctxOf(req);
    requireAdmin(ctx);
    const body = parse(stageUpdateSchema, req.body);
    const id = Number(req.params.id);
    const s = await q1<{ pipeline_id: number; kind: string }>(sql`SELECT s.pipeline_id, s.kind FROM stages s JOIN pipelines p ON p.id = s.pipeline_id WHERE s.id = ${id} AND p.workspace_id = ${ctx.workspaceId}`);
    if (!s) throw notFound('Stage');
    if (body.kind && body.kind !== s.kind) {
      const n = await q1<{ n: number }>(sql`SELECT ((SELECT count(*) FROM deals WHERE stage_id = ${id}) + (SELECT count(*) FROM leads WHERE stage_id = ${id}))::int AS n`);
      if (n!.n > 0) throw badRequest('You can’t change the type of a stage that has records in it');
      if (body.kind === 'won' && (await q1(sql`SELECT 1 FROM stages WHERE pipeline_id = ${s.pipeline_id} AND kind = 'won'`))) throw badRequest('A pipeline can have only one won stage');
    }
    const row = await q1(sql`UPDATE stages SET name = coalesce(${body.name ?? null}, name), color = coalesce(${body.color ?? null}, color),
      kind = coalesce(${body.kind ?? null}, kind),
      probability = CASE WHEN ${body.probability !== undefined} THEN ${body.probability ?? null}::smallint ELSE probability END,
      rot_days = CASE WHEN ${body.rotDays !== undefined} THEN ${body.rotDays ?? null}::int ELSE rot_days END
      WHERE id = ${id} RETURNING *`);
    return camel(row);
  });

  app.post<IdParams>('/pipelines/:id/stages/reorder', async (req) => {
    const ctx = ctxOf(req);
    requireAdmin(ctx);
    const body = parse(reorderSchema, req.body);
    const id = Number(req.params.id);
    await tx(async (db) => {
      const stages = await q<{ id: number }>(sql`SELECT s.id FROM stages s JOIN pipelines p ON p.id = s.pipeline_id WHERE s.pipeline_id = ${id} AND p.workspace_id = ${ctx.workspaceId}`, db);
      const known = new Set(stages.map((s) => s.id));
      if (body.ids.length !== known.size || body.ids.some((x) => !known.has(x))) throw badRequest('Provide every stage of the pipeline exactly once');
      for (const [i, sid] of body.ids.entries()) await q(sql`UPDATE stages SET sort = ${i} WHERE id = ${sid}`, db);
    });
    return { ok: true };
  });

  app.delete<IdParams>('/stages/:id', async (req, reply) => {
    const ctx = ctxOf(req);
    requireAdmin(ctx);
    const body = parse(stageDeleteSchema, req.body ?? {});
    const id = Number(req.params.id);
    await tx(async (db) => {
      const s = await q1<{ pipeline_id: number; kind: string }>(sql`SELECT s.pipeline_id, s.kind FROM stages s JOIN pipelines p ON p.id = s.pipeline_id WHERE s.id = ${id} AND p.workspace_id = ${ctx.workspaceId}`, db);
      if (!s) throw notFound('Stage');
      const openCount = await q1<{ n: number }>(sql`SELECT count(*)::int AS n FROM stages WHERE pipeline_id = ${s.pipeline_id} AND kind = 'open'`, db);
      if (s.kind === 'open' && openCount!.n <= 1) throw badRequest('A pipeline needs at least one open stage');
      if (s.kind === 'won') throw badRequest('The won stage cannot be deleted');
      const used = await q1<{ n: number }>(sql`SELECT ((SELECT count(*) FROM deals WHERE stage_id = ${id}) + (SELECT count(*) FROM leads WHERE stage_id = ${id}))::int AS n`, db);
      if (used!.n > 0) {
        if (!body.moveToStageId) throw badRequest(`This stage has ${used!.n} records. Choose a stage to move them to.`, { moveToStageId: 'Required' });
        const target = await q1<{ kind: string }>(sql`SELECT kind FROM stages WHERE id = ${body.moveToStageId} AND pipeline_id = ${s.pipeline_id} AND id <> ${id}`, db);
        if (!target) throw badRequest('Target stage must be another stage in the same pipeline');
        await q(sql`UPDATE deals SET stage_id = ${body.moveToStageId}, status = ${target.kind}, previous_stage_id = NULL WHERE stage_id = ${id}`, db);
        await q(sql`UPDATE leads SET stage_id = ${body.moveToStageId}, status = ${target.kind} WHERE stage_id = ${id}`, db);
      }
      await q(sql`UPDATE deals SET previous_stage_id = NULL WHERE previous_stage_id = ${id}`, db);
      await q(sql`UPDATE field_definitions SET required_stage_ids = array_remove(required_stage_ids, ${id}::bigint) WHERE workspace_id = ${ctx.workspaceId}`, db);
      await q(sql`DELETE FROM stages WHERE id = ${id}`, db);
    });
    return reply.code(204).send();
  });

  // ─────────────── Custom fields ───────────────
  app.post('/fields', async (req, reply) => {
    const ctx = ctxOf(req);
    requireAdmin(ctx);
    const body = parse(fieldCreateSchema, req.body);
    if (['select', 'multiselect'].includes(body.type) && body.options.length === 0) throw badRequest('Add at least one option', { options: 'Required' });
    if (body.required === 'from_stage' && body.requiredStageIds.length === 0) throw badRequest('Choose at least one stage', { requiredStageIds: 'Required' });
    if (body.required === 'from_stage' && !['lead', 'deal'].includes(body.entityType)) throw badRequest('Only leads and deals have stages');
    const key = body.key ?? (body.label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'f_$1').slice(0, 40) || 'field');
    const exists = await q1(sql`SELECT 1 FROM field_definitions WHERE workspace_id = ${ctx.workspaceId} AND entity_type = ${body.entityType} AND key = ${key}`);
    const finalKey = exists ? `${key.slice(0, 34)}_${Date.now().toString(36).slice(-5)}` : key;
    const row = await q1(sql`INSERT INTO field_definitions (workspace_id, entity_type, key, label, type, options, required, required_stage_ids, help_text, sort)
      VALUES (${ctx.workspaceId}, ${body.entityType}, ${finalKey}, ${body.label}, ${body.type}, ${JSON.stringify(body.options)}::jsonb, ${body.required},
              ${body.requiredStageIds}, ${body.helpText ?? null},
              (SELECT coalesce(max(sort),0)+1 FROM field_definitions WHERE workspace_id = ${ctx.workspaceId} AND entity_type = ${body.entityType}))
      RETURNING *`);
    return reply.code(201).send(camel(row));
  });

  app.patch<IdParams>('/fields/:id', async (req) => {
    const ctx = ctxOf(req);
    requireAdmin(ctx);
    const body = parse(fieldUpdateSchema, req.body);
    const id = Number(req.params.id);
    const f = await q1<{ type: string; entity_type: string }>(sql`SELECT type, entity_type FROM field_definitions WHERE id = ${id} AND workspace_id = ${ctx.workspaceId}`);
    if (!f) throw notFound('Field');
    if (body.options && ['select', 'multiselect'].includes(f.type) && body.options.length === 0) throw badRequest('Add at least one option');
    if (body.required === 'from_stage' && (!body.requiredStageIds || body.requiredStageIds.length === 0)) throw badRequest('Choose at least one stage', { requiredStageIds: 'Required' });
    const row = await q1(sql`UPDATE field_definitions SET
      label = coalesce(${body.label ?? null}, label),
      options = coalesce(${body.options ? JSON.stringify(body.options) : null}::jsonb, options),
      required = coalesce(${body.required ?? null}, required),
      required_stage_ids = coalesce(${body.requiredStageIds ?? null}::bigint[], required_stage_ids),
      help_text = CASE WHEN ${body.helpText !== undefined} THEN ${body.helpText ?? null} ELSE help_text END,
      is_active = coalesce(${body.isActive ?? null}, is_active)
      WHERE id = ${id} RETURNING *`);
    return camel(row);
  });

  app.post('/fields/reorder', async (req) => {
    const ctx = ctxOf(req);
    requireAdmin(ctx);
    const body = parse(reorderSchema, req.body);
    await tx(async (db) => {
      for (const [i, id] of body.ids.entries()) await q(sql`UPDATE field_definitions SET sort = ${i} WHERE id = ${id} AND workspace_id = ${ctx.workspaceId}`, db);
    });
    return { ok: true };
  });

  // ─────────────── Dictionaries ───────────────
  app.post('/dictionaries', async (req, reply) => {
    const ctx = ctxOf(req);
    requireAdmin(ctx);
    const body = parse(dictionaryItemSchema, req.body);
    const row = await q1(sql`INSERT INTO dictionary_items (workspace_id, kind, label, sort)
      VALUES (${ctx.workspaceId}, ${body.kind}, ${body.label}, (SELECT coalesce(max(sort),0)+1 FROM dictionary_items WHERE workspace_id = ${ctx.workspaceId} AND kind = ${body.kind}))
      RETURNING *`);
    return reply.code(201).send(camel(row));
  });
  app.patch<IdParams>('/dictionaries/:id', async (req) => {
    const ctx = ctxOf(req);
    requireAdmin(ctx);
    const body = parse(dictionaryUpdateSchema, req.body);
    const row = await q1(sql`UPDATE dictionary_items SET label = coalesce(${body.label ?? null}, label), is_active = coalesce(${body.isActive ?? null}, is_active)
      WHERE id = ${Number(req.params.id)} AND workspace_id = ${ctx.workspaceId} RETURNING *`);
    if (!row) throw notFound('Item');
    return camel(row);
  });

  // ─────────────── Users & invitations ───────────────
  app.post('/users/invite', async (req, reply) => {
    const ctx = ctxOf(req);
    requireAdmin(ctx);
    const body = parse(inviteSchema, req.body);
    const role = await q1(sql`SELECT 1 FROM roles WHERE id = ${body.roleId} AND workspace_id = ${ctx.workspaceId}`);
    if (!role) throw badRequest('Role not found', { roleId: 'Invalid role' });
    const token = newToken();
    await tx(async (db) => {
      let user = await q1<{ id: number }>(sql`SELECT id FROM users WHERE email = ${body.email}`, db);
      user ??= await q1<{ id: number }>(sql`INSERT INTO users (email, name) VALUES (${body.email}, ${body.name}) RETURNING id`, db);
      const m = await q1<{ status: string }>(sql`SELECT status FROM memberships WHERE workspace_id = ${ctx.workspaceId} AND user_id = ${user!.id}`, db);
      if (m && m.status !== 'invited') throw badRequest('This person is already a member', { email: 'Already a member' });
      await q(sql`INSERT INTO memberships (workspace_id, user_id, role_id, status, invite_token_hash, invited_by)
        VALUES (${ctx.workspaceId}, ${user!.id}, ${body.roleId}, 'invited', ${sha256(token)}, ${ctx.userId})
        ON CONFLICT (workspace_id, user_id) DO UPDATE SET role_id = EXCLUDED.role_id, invite_token_hash = EXCLUDED.invite_token_hash`, db);
    });
    // Email delivery is pluggable; the admin can copy the link from the response.
    const inviteUrl = `${config.appUrl}/invite/${token}`;
    req.log.info({ inviteUrl, email: body.email }, 'invitation created');
    return reply.code(201).send({ inviteUrl });
  });

  app.patch<IdParams>('/users/:id', async (req) => {
    const ctx = ctxOf(req);
    requireAdmin(ctx);
    const body = parse(memberUpdateSchema, req.body);
    const userId = Number(req.params.id);
    if (userId === ctx.userId && (body.status === 'disabled' || body.roleId)) {
      const r = body.roleId ? await q1<{ is_admin: boolean }>(sql`SELECT is_admin FROM roles WHERE id = ${body.roleId}`) : null;
      if (body.status === 'disabled' || (r && !r.is_admin)) throw badRequest('You can’t remove your own admin access');
    }
    if (body.roleId && !(await q1(sql`SELECT 1 FROM roles WHERE id = ${body.roleId} AND workspace_id = ${ctx.workspaceId}`))) throw badRequest('Role not found');
    const row = await q1(sql`UPDATE memberships SET role_id = coalesce(${body.roleId ?? null}, role_id),
      status = CASE WHEN status = 'invited' THEN status ELSE coalesce(${body.status ?? null}, status) END
      WHERE workspace_id = ${ctx.workspaceId} AND user_id = ${userId} RETURNING *`);
    if (!row) throw notFound('User');
    if (body.status === 'disabled') await q(sql`DELETE FROM sessions WHERE user_id = ${userId} AND workspace_id = ${ctx.workspaceId}`);
    return camel(row);
  });

  // ─────────────── Roles ───────────────
  app.get('/roles', async (req) => {
    const ctx = ctxOf(req);
    const roles = await q<{ id: number }>(sql`SELECT r.id, r.name, r.is_admin, r.is_system,
      (SELECT count(*)::int FROM memberships m WHERE m.role_id = r.id) AS member_count FROM roles r WHERE r.workspace_id = ${ctx.workspaceId} ORDER BY r.id`);
    const grants = await q<{ role_id: number; entity: string; action: string; scope: string }>(sql`SELECT g.role_id, g.entity, g.action, g.scope FROM role_grants g
      JOIN roles r ON r.id = g.role_id WHERE r.workspace_id = ${ctx.workspaceId}`);
    return {
      data: camelAll(roles).map((r) => {
        const out: Record<string, Record<string, string>> = {};
        for (const g of grants.filter((x) => x.role_id === (r as { id: number }).id)) (out[g.entity] ??= {})[g.action] = g.scope;
        return { ...r, grants: out };
      }),
    };
  });
  app.post('/roles', async (req, reply) => {
    const ctx = ctxOf(req);
    requireAdmin(ctx);
    const body = parse(roleCreateSchema, req.body);
    const id = await tx(async (db) => {
      const r = await q1<{ id: number }>(sql`INSERT INTO roles (workspace_id, name) VALUES (${ctx.workspaceId}, ${body.name}) RETURNING id`, db);
      await setRoleGrants(db, r!.id, body.grants);
      return r!.id;
    });
    return reply.code(201).send({ id });
  });
  app.patch<IdParams>('/roles/:id', async (req) => {
    const ctx = ctxOf(req);
    requireAdmin(ctx);
    const body = parse(roleUpdateSchema, req.body);
    const id = Number(req.params.id);
    const role = await q1<{ is_admin: boolean }>(sql`SELECT is_admin FROM roles WHERE id = ${id} AND workspace_id = ${ctx.workspaceId}`);
    if (!role) throw notFound('Role');
    if (role.is_admin && body.grants) throw badRequest('The Admin role always has full access');
    await tx(async (db) => {
      if (body.name) await q(sql`UPDATE roles SET name = ${body.name} WHERE id = ${id}`, db);
      if (body.grants) await setRoleGrants(db, id, body.grants);
    });
    return { ok: true };
  });
  app.delete<IdParams>('/roles/:id', async (req, reply) => {
    const ctx = ctxOf(req);
    requireAdmin(ctx);
    const id = Number(req.params.id);
    const role = await q1<{ is_system: boolean; n: number }>(sql`SELECT is_system, (SELECT count(*)::int FROM memberships WHERE role_id = ${id}) AS n
      FROM roles WHERE id = ${id} AND workspace_id = ${ctx.workspaceId}`);
    if (!role) throw notFound('Role');
    if (role.is_system) throw badRequest('Built-in roles cannot be deleted');
    if (role.n > 0) throw badRequest('Move members to another role before deleting this one');
    await q(sql`DELETE FROM roles WHERE id = ${id}`);
    return reply.code(204).send();
  });

  // ─────────────── Teams ───────────────
  async function saveMembers(db: Parameters<typeof q>[1], teamId: number, ws: number, ids: number[]) {
    await q(sql`DELETE FROM team_members WHERE team_id = ${teamId}`, db);
    const valid = await q<{ user_id: number }>(sql`SELECT user_id FROM memberships WHERE workspace_id = ${ws} AND user_id = ANY(${ids})`, db);
    for (const v of valid) await q(sql`INSERT INTO team_members (team_id, user_id) VALUES (${teamId}, ${v.user_id})`, db);
  }
  app.post('/teams', async (req, reply) => {
    const ctx = ctxOf(req);
    requireAdmin(ctx);
    const body = parse(teamSchema, req.body);
    const id = await tx(async (db) => {
      const t = await q1<{ id: number }>(sql`INSERT INTO teams (workspace_id, name) VALUES (${ctx.workspaceId}, ${body.name}) RETURNING id`, db);
      await saveMembers(db, t!.id, ctx.workspaceId, body.memberIds);
      return t!.id;
    });
    return reply.code(201).send({ id });
  });
  app.patch<IdParams>('/teams/:id', async (req) => {
    const ctx = ctxOf(req);
    requireAdmin(ctx);
    const body = parse(teamSchema.partial(), req.body);
    const id = Number(req.params.id);
    await tx(async (db) => {
      const t = await q1(sql`SELECT 1 FROM teams WHERE id = ${id} AND workspace_id = ${ctx.workspaceId}`, db);
      if (!t) throw notFound('Team');
      if (body.name) await q(sql`UPDATE teams SET name = ${body.name} WHERE id = ${id}`, db);
      if (body.memberIds) await saveMembers(db, id, ctx.workspaceId, body.memberIds);
    });
    return { ok: true };
  });
  app.delete<IdParams>('/teams/:id', async (req, reply) => {
    const ctx = ctxOf(req);
    requireAdmin(ctx);
    await q(sql`DELETE FROM teams WHERE id = ${Number(req.params.id)} AND workspace_id = ${ctx.workspaceId}`);
    return reply.code(204).send();
  });
}
