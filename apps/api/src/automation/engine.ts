import { pool, q, q1, raw, sql, tx, type Db } from '../db/index.ts';
import { audit } from '../lib/audit.ts';
import { systemCtx, type Ctx } from '../lib/context.ts';
import { loadDefs, mergeCustom } from '../lib/customFields.ts';
import { createActivity } from '../routes/activities.ts';
import { moveDeal } from '../routes/deals.ts';
import { moveLead } from '../routes/leads.ts';
import { runChunk } from '../imports/engine.ts';

export const MAX_DEPTH = 5;
const RETENTION_DAYS = 30;

interface Rule {
  id: number; workspace_id: number; entity_type: 'deal' | 'lead'; pipeline_id: number; stage_id: number | null; trigger: string;
  delay_minutes: number; conditions: { field: string; op: string; value?: unknown }[]; action: string; config: Record<string, unknown>; is_enabled: boolean;
}

// ───────────────────────── Outbox → scheduled runs ─────────────────────────
export async function processOutbox(limit = 100): Promise<number> {
  return tx(async (db) => {
    const events = await q<{ id: number; workspace_id: number; type: string; entity_type: 'deal' | 'lead'; entity_id: number; payload: { stageId?: number }; depth: number }>(
      sql`SELECT * FROM outbox_events WHERE processed_at IS NULL ORDER BY id LIMIT ${limit} FOR UPDATE SKIP LOCKED`, db);
    for (const ev of events) {
      if (ev.depth < MAX_DEPTH) {
        const table = ev.entity_type === 'deal' ? 'deals' : 'leads';
        const rec = await q1<{ pipeline_id: number }>(sql`SELECT pipeline_id FROM ${raw(table)} WHERE id = ${ev.entity_id}`, db);
        if (rec) {
          const trigger = ev.type.endsWith('.created') ? 'created' : 'stage_entered';
          const rules = await q<Rule>(sql`SELECT * FROM automation_rules WHERE workspace_id = ${ev.workspace_id} AND is_enabled
            AND entity_type = ${ev.entity_type} AND pipeline_id = ${rec.pipeline_id} AND trigger = ${trigger}
            AND (stage_id IS NULL OR stage_id = ${ev.payload.stageId ?? null}) ORDER BY sort, id`, db);
          for (const r of rules) {
            const run = await q1<{ id: number; scheduled_for: Date }>(sql`INSERT INTO automation_runs (workspace_id, rule_id, entity_type, entity_id, status, scheduled_for, depth)
              VALUES (${ev.workspace_id}, ${r.id}, ${ev.entity_type}, ${ev.entity_id}, 'scheduled', now() + ${r.delay_minutes} * interval '1 minute', ${ev.depth})
              RETURNING id, scheduled_for`, db);
            await q(sql`INSERT INTO jobs (type, payload, run_at) VALUES ('automation.run',
              ${JSON.stringify({ runId: run!.id, ruleId: r.id, entityType: ev.entity_type, entityId: ev.entity_id, stageId: ev.payload.stageId ?? null, depth: ev.depth })}, ${run!.scheduled_for})`, db);
          }
        }
      }
      await q(sql`UPDATE outbox_events SET processed_at = now() WHERE id = ${ev.id}`, db);
    }
    return events.length;
  });
}

// ───────────────────────── Job queue ─────────────────────────
export async function enqueue(type: string, payload: Record<string, unknown> = {}, runAt = new Date(), db: Db = pool) {
  await q(sql`INSERT INTO jobs (type, payload, run_at) VALUES (${type}, ${JSON.stringify(payload)}, ${runAt})`, db);
}

/** `now` overrides the clock (tests); by default the database clock is used. */
export async function processJobs(limit = 20, now?: Date): Promise<number> {
  const jobs = await tx((db) => q<{ id: number; type: string; payload: Record<string, unknown>; attempts: number }>(sql`
    UPDATE jobs SET status = 'running', locked_at = now(), attempts = attempts + 1
    WHERE id IN (SELECT id FROM jobs WHERE status = 'pending' AND run_at <= coalesce(${now ?? null}::timestamptz, now()) ORDER BY run_at, id LIMIT ${limit} FOR UPDATE SKIP LOCKED)
    RETURNING id, type, payload, attempts`, db));
  for (const job of jobs) {
    try {
      if (job.type === 'automation.run') await runAutomation(job.payload as never);
      else if (job.type === 'reminders') await sendReminders(now ?? new Date());
      else if (job.type === 'purge') await purge();
      else if (job.type === 'import.run') await runChunk(Number((job.payload as { importId: number }).importId));
      await q(sql`UPDATE jobs SET status = 'done' WHERE id = ${job.id}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const retry = job.attempts < 3;
      await q(sql`UPDATE jobs SET status = ${retry ? 'pending' : 'failed'}, last_error = ${msg},
        run_at = now() + (${job.attempts * 30} || ' seconds')::interval WHERE id = ${job.id}`);
      if (!retry && job.type === 'import.run') {
        await q(sql`UPDATE imports SET status = 'failed', error = 'The import stopped because of an unexpected error', finished_at = now()
          WHERE id = ${(job.payload as { importId: number }).importId} AND status IN ('queued','running')`);
      }
      if (!retry && job.type === 'automation.run') {
        await q(sql`UPDATE automation_runs SET status = 'failed', finished_at = now(), message = ${msg} WHERE id = ${(job.payload as { runId: number }).runId}`);
      }
    }
  }
  return jobs.length;
}

/** Recover jobs stuck in "running" (worker crashed). */
export async function releaseStuckJobs() {
  await q(sql`UPDATE jobs SET status = 'pending' WHERE status = 'running' AND locked_at < now() - interval '10 minutes'`);
}

// ───────────────────────── Rule execution ─────────────────────────
function fieldValue(rec: Record<string, unknown>, field: string): unknown {
  if (field.startsWith('custom.')) return (rec.custom as Record<string, unknown> | undefined)?.[field.slice(7)];
  const col = field.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
  return rec[col];
}

export function evaluateConditions(rec: Record<string, unknown>, conditions: Rule['conditions']): boolean {
  return conditions.every((c) => {
    const v = fieldValue(rec, c.field);
    const empty = v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
    const num = (x: unknown) => Number(x);
    switch (c.op) {
      case 'empty': return empty;
      case 'not_empty': return !empty;
      case 'eq': return String(v ?? '') === String(c.value ?? '');
      case 'neq': return String(v ?? '') !== String(c.value ?? '');
      case 'gt': return !empty && num(v) > num(c.value);
      case 'lt': return !empty && num(v) < num(c.value);
      default: return false;
    }
  });
}

function render(template: string, rec: Record<string, unknown>, ownerName: string): string {
  return template
    .replace(/\{\{\s*title\s*\}\}/g, String(rec.title ?? ''))
    .replace(/\{\{\s*amount\s*\}\}/g, rec.amount ? `${rec.currency ?? ''} ${Number(rec.amount).toLocaleString('en-US')}`.trim() : '')
    .replace(/\{\{\s*owner\s*\}\}/g, ownerName);
}

async function finishRun(runId: number, status: 'success' | 'skipped' | 'failed', message: string) {
  await q(sql`UPDATE automation_runs SET status = ${status}, finished_at = now(), message = ${message} WHERE id = ${runId}`);
}

export async function runAutomation(p: { runId: number; ruleId: number; entityType: 'deal' | 'lead'; entityId: number; stageId: number | null; depth: number }) {
  const rule = await q1<Rule>(sql`SELECT * FROM automation_rules WHERE id = ${p.ruleId}`);
  if (!rule || !rule.is_enabled) return finishRun(p.runId, 'skipped', 'Rule disabled or deleted');
  const table = p.entityType === 'deal' ? 'deals' : 'leads';
  const rec = await q1<Record<string, unknown> & { owner_id: number | null; stage_id: number; title: string; workspace_id: number }>(
    sql`SELECT * FROM ${raw(table)} WHERE id = ${p.entityId} AND deleted_at IS NULL`);
  if (!rec) return finishRun(p.runId, 'skipped', 'Record deleted');
  if (rule.trigger === 'stage_entered' && rule.stage_id && rec.stage_id !== rule.stage_id) {
    return finishRun(p.runId, 'skipped', 'Record already left the stage');
  }
  if (!evaluateConditions(rec, rule.conditions ?? [])) return finishRun(p.runId, 'skipped', 'Conditions not met');

  const ws = await q1<{ base_currency: string }>(sql`SELECT base_currency FROM workspaces WHERE id = ${rec.workspace_id}`);
  const fallbackUser = rec.owner_id ?? (await q1<{ user_id: number }>(sql`SELECT m.user_id FROM memberships m JOIN roles r ON r.id = m.role_id
    WHERE m.workspace_id = ${rec.workspace_id} AND r.is_admin AND m.status = 'active' ORDER BY m.created_at LIMIT 1`))?.user_id;
  if (!fallbackUser) return finishRun(p.runId, 'failed', 'No user available to act on behalf of');
  const ctx: Ctx = { ...systemCtx(rec.workspace_id, fallbackUser, ws?.base_currency), depth: p.depth + 1 };
  const owner = await q1<{ name: string }>(sql`SELECT name FROM users WHERE id = ${rec.owner_id ?? 0}`);
  const ownerName = owner?.name ?? '';
  const cfg = rule.config ?? {};
  const target = (v: unknown) => (v === 'owner' || v === undefined ? rec.owner_id ?? fallbackUser : Number(v));

  let message = '';
  await tx(async (db) => {
    switch (rule.action) {
      case 'create_activity': {
        const minutes = Number(cfg.dueInMinutes ?? 0) + Number(cfg.dueInDays ?? 0) * 1440;
        const due = new Date(Date.now() + minutes * 60_000);
        await createActivity(db, ctx, {
          kind: (cfg.kind as 'task') ?? 'task', subject: render(String(cfg.subject ?? 'Follow up on {{title}}'), rec, ownerName).slice(0, 200),
          description: cfg.description ? render(String(cfg.description), rec, ownerName) : null, dueAt: due.toISOString(),
          priority: (cfg.priority as 'normal') ?? 'normal', assigneeId: target(cfg.assignTo), links: [{ entityType: p.entityType, entityId: p.entityId }],
        } as never, 'automation');
        message = `Created ${cfg.kind ?? 'task'} "${cfg.subject ?? ''}"`;
        break;
      }
      case 'notify': {
        const userId = target(cfg.userId);
        await q(sql`INSERT INTO notifications (workspace_id, user_id, kind, title, body, entity_type, entity_id)
          VALUES (${rec.workspace_id}, ${userId}, 'automation', ${render(String(cfg.title ?? 'Automation: {{title}}'), rec, ownerName).slice(0, 200)},
                  ${render(String(cfg.message ?? ''), rec, ownerName).slice(0, 2000)}, ${p.entityType}, ${p.entityId})`, db);
        message = 'Notification sent';
        break;
      }
      case 'add_note': {
        await q(sql`INSERT INTO notes (workspace_id, entity_type, entity_id, body, author_type) VALUES (${rec.workspace_id}, ${p.entityType}, ${p.entityId},
          ${render(String(cfg.text ?? ''), rec, ownerName) || 'Automation note'}, 'automation')`, db);
        message = 'Note added';
        break;
      }
      case 'update_field': {
        const field = String(cfg.field ?? '');
        const allowed: Record<string, string> = { probability: 'probability', description: 'description', expectedCloseDate: 'expected_close_date', sourceId: 'source_id', visibility: 'visibility' };
        if (field.startsWith('custom.')) {
          const defs = await loadDefs(rec.workspace_id, p.entityType, db);
          const custom = mergeCustom(defs, { [field.slice(7)]: cfg.value }, rec.custom as Record<string, unknown>);
          await q(sql`UPDATE ${raw(table)} SET custom = ${JSON.stringify(custom)}::jsonb, updated_at = now() WHERE id = ${p.entityId}`, db);
        } else if (allowed[field] && !(p.entityType === 'lead' && ['probability', 'expectedCloseDate'].includes(field))) {
          await q(sql`UPDATE ${raw(table)} SET ${raw(allowed[field])} = ${cfg.value ?? null}, updated_at = now() WHERE id = ${p.entityId}`, db);
        } else throw new Error(`Field "${field}" cannot be changed by automation`);
        await audit(db, ctx, p.entityType, p.entityId, 'updated', { [field]: [fieldValue(rec, field) ?? null, cfg.value ?? null] }, 'automation');
        message = `Set ${field}`;
        break;
      }
      case 'assign_owner': {
        let userId: number | undefined;
        if (cfg.mode === 'round_robin' && cfg.teamId) {
          // Pick the team member with the fewest open records of this type (ties → lowest id).
          const pick = await q1<{ user_id: number }>(sql`SELECT tm.user_id FROM team_members tm
            JOIN memberships m ON m.user_id = tm.user_id AND m.workspace_id = ${rec.workspace_id} AND m.status = 'active'
            WHERE tm.team_id = ${Number(cfg.teamId)}
            ORDER BY (SELECT count(*) FROM ${raw(table)} x WHERE x.owner_id = tm.user_id AND x.status = 'open' AND x.deleted_at IS NULL), tm.user_id LIMIT 1`, db);
          userId = pick?.user_id;
        } else userId = cfg.userId ? Number(cfg.userId) : undefined;
        if (!userId) throw new Error('No user to assign');
        await q(sql`UPDATE ${raw(table)} SET owner_id = ${userId}, updated_at = now() WHERE id = ${p.entityId}`, db);
        await audit(db, ctx, p.entityType, p.entityId, 'owner_changed', { owner: [rec.owner_id, userId] }, 'automation');
        await q(sql`INSERT INTO notifications (workspace_id, user_id, kind, title, body, entity_type, entity_id)
          VALUES (${rec.workspace_id}, ${userId}, 'assigned', ${`You are now the owner of "${rec.title}"`}, NULL, ${p.entityType}, ${p.entityId})`, db);
        message = `Assigned to user #${userId}`;
        break;
      }
      case 'move_stage': {
        const stageId = Number(cfg.stageId);
        if (p.entityType === 'deal') await moveDeal(db, ctx, p.entityId, { stageId }, { checkPermission: false });
        else await moveLead(db, ctx, p.entityId, { stageId }, { checkPermission: false });
        message = `Moved to stage #${stageId}`;
        break;
      }
      default: throw new Error(`Unknown action ${rule.action}`);
    }
  });
  await finishRun(p.runId, 'success', message);
}

// ───────────────────────── Reminders & purge ─────────────────────────
export async function sendReminders(now = new Date()) {
  await q(sql`WITH due AS (
      UPDATE activities SET reminded_at = now() WHERE status = 'open' AND deleted_at IS NULL AND reminded_at IS NULL
        AND reminder_at IS NOT NULL AND reminder_at <= ${now} RETURNING id, workspace_id, assignee_id, subject, due_at)
    INSERT INTO notifications (workspace_id, user_id, kind, title, body, entity_type, entity_id)
    SELECT workspace_id, assignee_id, 'reminder', 'Reminder: ' || subject, to_char(due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC', 'activity', id
    FROM due WHERE assignee_id IS NOT NULL`);
}

export async function purge() {
  for (const t of ['deals', 'leads', 'contacts', 'companies', 'products']) {
    await q(sql`DELETE FROM ${raw(t)} WHERE deleted_at < now() - ${RETENTION_DAYS + ' days'}::interval`);
  }
  await q(sql`DELETE FROM contact_methods cm WHERE NOT EXISTS (
    SELECT 1 FROM contacts c WHERE cm.party_type = 'contact' AND c.id = cm.party_id
    UNION ALL SELECT 1 FROM companies c WHERE cm.party_type = 'company' AND c.id = cm.party_id
    UNION ALL SELECT 1 FROM leads l WHERE cm.party_type = 'lead' AND l.id = cm.party_id)`);
  await q(sql`DELETE FROM sessions WHERE expires_at < now()`);
  // CSV imports: drop the raw cells 30 days after finishing; drafts that were never started go after 7 days.
  await q(sql`UPDATE imports SET rows = NULL WHERE rows IS NOT NULL AND finished_at < now() - ${RETENTION_DAYS + ' days'}::interval`);
  await q(sql`DELETE FROM imports WHERE status = 'draft' AND created_at < now() - interval '7 days'`);
  await q(sql`DELETE FROM jobs WHERE status IN ('done','failed') AND created_at < now() - interval '14 days'`);
  await q(sql`DELETE FROM outbox_events WHERE processed_at < now() - interval '14 days'`);
}

/** Long-running loop used by the API process (inline) or the dedicated worker. */
export function startWorker(log: (m: string) => void = () => {}): () => void {
  let stopped = false;
  let lastReminder = 0;
  let lastPurge = 0;
  const tick = async () => {
    if (stopped) return;
    try {
      const now = Date.now();
      if (now - lastReminder > 60_000) { lastReminder = now; await sendReminders(); }
      if (now - lastPurge > 3_600_000) { lastPurge = now; await purge(); await releaseStuckJobs(); }
      const n = (await processOutbox()) + (await processJobs());
      if (n) log(`worker processed ${n} items`);
    } catch (e) {
      log(`worker error: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!stopped) setTimeout(tick, 1500);
  };
  setTimeout(tick, 500);
  return () => { stopped = true; };
}
