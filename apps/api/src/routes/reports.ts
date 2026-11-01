import type { FastifyInstance, FastifyReply } from 'fastify';
import { q, q1, raw, sql, type Fragment } from '../db/index.ts';
import type { Ctx } from '../lib/context.ts';
import { badRequest, forbidden } from '../lib/errors.ts';
import { ctxOf } from '../lib/http.ts';
import { qs } from '../lib/list.ts';
import { scopeOf, scopeWhere } from '../lib/permissions.ts';
import { camelAll } from '../lib/records.ts';

interface Period { from: string; to: string }

function period(query: Record<string, unknown>): Period {
  const now = new Date();
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  const from = qs.date(query.from) ?? first;
  const to = qs.date(query.to) ?? last;
  if (from > to) throw badRequest('"From" must be before "to"');
  return { from, to };
}

/** me / team / all, narrowed by what the role may see. */
function ownerScope(ctx: Ctx, entity: 'deal' | 'lead', alias: string, query: Record<string, unknown>): Fragment {
  if (scopeOf(ctx, entity, 'view') === 'none') throw forbidden();
  const base = scopeWhere(ctx, entity, 'view', alias);
  const owner = qs.id(query.ownerId);
  const s = qs.str(query.scope);
  const col = raw(`${alias}.owner_id`);
  if (owner) return sql`(${base} AND ${col} = ${owner})`;
  if (s === 'me') return sql`(${base} AND ${col} = ${ctx.userId})`;
  if (s === 'team') return sql`(${base} AND ${col} = ANY(${ctx.teamUserIds}))`;
  return base;
}

function sendCsv(reply: FastifyReply, name: string, rows: Record<string, unknown>[]) {
  const cols = rows.length ? Object.keys(rows[0]) : [];
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; // neutralise spreadsheet formula injection
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const body = [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
  reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${name}.csv"`);
  return reply.send(body);
}

export async function reportRoutes(app: FastifyInstance) {
  app.get('/dashboard', async (req) => {
    const ctx = ctxOf(req);
    const query = req.query as Record<string, unknown>;
    const p = period(query);
    const canDeals = scopeOf(ctx, 'deal', 'view') !== 'none';
    const dealScope = canDeals ? ownerScope(ctx, 'deal', 'd', query) : sql`FALSE`;
    const pipelineId = qs.id(query.pipelineId) ?? (await q1<{ id: number }>(sql`SELECT id FROM pipelines WHERE workspace_id = ${ctx.workspaceId} AND entity_type = 'deal' ORDER BY is_default DESC, sort LIMIT 1`))?.id;
    const ws = ctx.workspaceId;
    const [kpi, byStage, trend, myDay, recent, leadKpi] = await Promise.all([
      q1(sql`SELECT
          coalesce(sum(amount) FILTER (WHERE status = 'open'), 0)::text AS open_amount,
          count(*) FILTER (WHERE status = 'open')::int AS open_count,
          coalesce(sum(amount * coalesce(probability, 0) / 100.0) FILTER (WHERE status = 'open'), 0)::numeric(18,2)::text AS weighted_amount,
          coalesce(sum(amount) FILTER (WHERE status = 'won' AND closed_at::date BETWEEN ${p.from}::date AND ${p.to}::date), 0)::text AS won_amount,
          count(*) FILTER (WHERE status = 'won' AND closed_at::date BETWEEN ${p.from}::date AND ${p.to}::date)::int AS won_count,
          count(*) FILTER (WHERE status = 'lost' AND closed_at::date BETWEEN ${p.from}::date AND ${p.to}::date)::int AS lost_count,
          count(*) FILTER (WHERE status = 'open' AND expected_close_date < current_date)::int AS overdue_deals
        FROM deals d WHERE d.workspace_id = ${ws} AND d.deleted_at IS NULL AND ${dealScope}`),
      pipelineId ? q(sql`SELECT s.id, s.name, s.color, s.kind, count(d.id)::int AS count, coalesce(sum(d.amount), 0)::text AS amount
        FROM stages s LEFT JOIN deals d ON d.stage_id = s.id AND d.deleted_at IS NULL AND ${dealScope}
        WHERE s.pipeline_id = ${pipelineId} AND s.kind = 'open' GROUP BY s.id ORDER BY s.sort`) : Promise.resolve([]),
      q(sql`SELECT to_char(m, 'YYYY-MM') AS month,
          coalesce(sum(d.amount) FILTER (WHERE d.status = 'won'), 0)::text AS won,
          coalesce(sum(d.amount) FILTER (WHERE d.status = 'lost'), 0)::text AS lost
        FROM generate_series(date_trunc('month', current_date) - interval '5 months', date_trunc('month', current_date), interval '1 month') m
        LEFT JOIN deals d ON d.workspace_id = ${ws} AND d.deleted_at IS NULL AND ${dealScope} AND date_trunc('month', d.closed_at) = m
        GROUP BY m ORDER BY m`),
      q(sql`SELECT a.id, a.kind, a.subject, a.due_at, a.priority,
          (SELECT json_build_object('entityType', al.entity_type, 'entityId', al.entity_id) FROM activity_links al WHERE al.activity_id = a.id LIMIT 1) AS link
        FROM activities a WHERE a.workspace_id = ${ws} AND a.assignee_id = ${ctx.userId} AND a.status = 'open' AND a.deleted_at IS NULL
          AND (a.due_at < date_trunc('day', now()) + interval '1 day')
        ORDER BY a.due_at NULLS LAST LIMIT 10`),
      canDeals ? q(sql`SELECT e.id, e.entity_type, e.entity_id, e.action, e.changes, e.created_at, u.name AS actor_name, d.title
        FROM audit_events e JOIN deals d ON d.id = e.entity_id AND e.entity_type = 'deal' AND d.deleted_at IS NULL
        LEFT JOIN users u ON u.id = e.actor_id
        WHERE e.workspace_id = ${ws} AND ${dealScope} AND e.action IN ('created','stage_changed','won','lost','reopened')
        ORDER BY e.created_at DESC LIMIT 8`) : Promise.resolve([]),
      scopeOf(ctx, 'lead', 'view') !== 'none' && ctx.useLeads ? q1(sql`SELECT count(*) FILTER (WHERE status = 'open')::int AS open_leads,
          count(*) FILTER (WHERE created_at::date BETWEEN ${p.from}::date AND ${p.to}::date)::int AS new_leads
        FROM leads l WHERE l.workspace_id = ${ws} AND l.deleted_at IS NULL AND ${ownerScope(ctx, 'lead', 'l', query)}`) : Promise.resolve(null),
    ]);
    const k = kpi as Record<string, number | string>;
    const decided = Number(k.won_count) + Number(k.lost_count);
    const overdue = await q1<{ n: number }>(sql`SELECT count(*)::int AS n FROM activities WHERE workspace_id = ${ws} AND assignee_id = ${ctx.userId}
      AND status = 'open' AND deleted_at IS NULL AND due_at < now()`);
    return {
      period: p, pipelineId,
      kpis: {
        openAmount: k.open_amount, openCount: k.open_count, weightedAmount: k.weighted_amount, wonAmount: k.won_amount, wonCount: k.won_count,
        lostCount: k.lost_count, winRate: decided ? Math.round((Number(k.won_count) / decided) * 100) : null,
        overdueDeals: k.overdue_deals, overdueActivities: overdue?.n ?? 0,
        openLeads: (leadKpi as { open_leads?: number } | null)?.open_leads ?? null, newLeads: (leadKpi as { new_leads?: number } | null)?.new_leads ?? null,
      },
      byStage: camelAll(byStage), trend: camelAll(trend), myDay: camelAll(myDay), recent: camelAll(recent),
    };
  });

  app.get<{ Params: { key: string } }>('/reports/:key', async (req, reply) => {
    const ctx = ctxOf(req);
    const query = req.query as Record<string, unknown>;
    const p = period(query);
    const ws = ctx.workspaceId;
    const pipe = qs.id(query.pipelineId);
    const pipeFilter = pipe ? sql`AND d.pipeline_id = ${pipe}` : sql``;
    let rows: Record<string, unknown>[];
    let totals: Record<string, unknown> | undefined;
    switch (req.params.key) {
      case 'won-deals': {
        rows = await q(sql`SELECT d.id, d.title, d.amount, d.currency, d.closed_at, co.name AS company, u.name AS owner, p.name AS pipeline
          FROM deals d LEFT JOIN companies co ON co.id = d.company_id LEFT JOIN users u ON u.id = d.owner_id JOIN pipelines p ON p.id = d.pipeline_id
          WHERE d.workspace_id = ${ws} AND d.deleted_at IS NULL AND d.status = 'won' AND d.closed_at::date BETWEEN ${p.from}::date AND ${p.to}::date
            ${pipeFilter} AND ${ownerScope(ctx, 'deal', 'd', query)} ORDER BY d.closed_at DESC`);
        totals = { count: rows.length, amount: rows.reduce((a, r) => a + Number(r.amount), 0).toFixed(2) };
        break;
      }
      case 'deals-by-stage': {
        rows = await q(sql`SELECT s.name AS stage, s.kind, p.name AS pipeline, count(d.id)::int AS deals, coalesce(sum(d.amount),0)::text AS amount
          FROM stages s JOIN pipelines p ON p.id = s.pipeline_id AND p.workspace_id = ${ws} AND p.entity_type = 'deal'
          LEFT JOIN deals d ON d.stage_id = s.id AND d.deleted_at IS NULL AND d.created_at::date <= ${p.to}::date
            AND (d.status = 'open' OR d.closed_at::date BETWEEN ${p.from}::date AND ${p.to}::date) AND ${ownerScope(ctx, 'deal', 'd', query)}
          WHERE ${pipe ? sql`p.id = ${pipe}` : sql`TRUE`} GROUP BY s.id, p.id ORDER BY p.sort, p.id, s.sort`);
        const total = rows.reduce((a, r) => a + Number(r.deals), 0);
        rows = rows.map((r) => ({ ...r, share: total ? Math.round((Number(r.deals) / total) * 1000) / 10 : 0 }));
        totals = { deals: total, amount: rows.reduce((a, r) => a + Number(r.amount), 0).toFixed(2) };
        break;
      }
      case 'deals-by-owner': {
        rows = await q(sql`SELECT u.name AS owner, count(d.id)::int AS deals,
            count(*) FILTER (WHERE d.status = 'open')::int AS open, count(*) FILTER (WHERE d.status = 'won')::int AS won,
            count(*) FILTER (WHERE d.status = 'lost')::int AS lost, coalesce(sum(d.amount),0)::text AS total_amount,
            coalesce(sum(d.amount) FILTER (WHERE d.status = 'won'),0)::text AS won_amount,
            coalesce(avg(d.amount) FILTER (WHERE d.status = 'won'),0)::numeric(18,2)::text AS avg_won_deal
          FROM deals d JOIN users u ON u.id = d.owner_id
          WHERE d.workspace_id = ${ws} AND d.deleted_at IS NULL AND d.created_at::date <= ${p.to}::date
            AND (d.status = 'open' OR d.closed_at::date BETWEEN ${p.from}::date AND ${p.to}::date) ${pipeFilter} AND ${ownerScope(ctx, 'deal', 'd', query)}
          GROUP BY u.id ORDER BY sum(d.amount) FILTER (WHERE d.status = 'won') DESC NULLS LAST`);
        rows = rows.map((r) => {
          const decided = Number(r.won) + Number(r.lost);
          return { ...r, win_rate: decided ? Math.round((Number(r.won) / decided) * 100) : null };
        });
        break;
      }
      case 'lead-conversion': {
        const group = query.groupBy === 'owner' ? sql`u.name` : sql`coalesce(src.label, 'No source')`;
        rows = await q(sql`SELECT ${group} AS ${raw(query.groupBy === 'owner' ? 'owner' : 'source')},
            count(*)::int AS leads, count(*) FILTER (WHERE l.status = 'won')::int AS converted,
            count(*) FILTER (WHERE l.status = 'lost')::int AS disqualified, count(*) FILTER (WHERE l.status = 'open')::int AS open
          FROM leads l LEFT JOIN dictionary_items src ON src.id = l.source_id LEFT JOIN users u ON u.id = l.owner_id
          WHERE l.workspace_id = ${ws} AND l.deleted_at IS NULL AND l.created_at::date BETWEEN ${p.from}::date AND ${p.to}::date
            AND ${ownerScope(ctx, 'lead', 'l', query)} GROUP BY 1 ORDER BY 2 DESC`);
        rows = rows.map((r) => ({ ...r, conversion_rate: Number(r.leads) ? Math.round((Number(r.converted) / Number(r.leads)) * 100) : 0 }));
        const t = rows.reduce<{ leads: number; converted: number }>((a, r) => ({ leads: a.leads + Number(r.leads), converted: a.converted + Number(r.converted) }), { leads: 0, converted: 0 });
        totals = { ...t, conversionRate: t.leads ? Math.round((t.converted / t.leads) * 100) : 0 };
        break;
      }
      case 'overdue-deals': {
        rows = await q(sql`SELECT d.id, d.title, d.amount, d.currency, d.expected_close_date, current_date - d.expected_close_date AS days_overdue,
            s.name AS stage, u.name AS owner FROM deals d JOIN stages s ON s.id = d.stage_id LEFT JOIN users u ON u.id = d.owner_id
          WHERE d.workspace_id = ${ws} AND d.deleted_at IS NULL AND d.status = 'open' AND d.expected_close_date < current_date
            ${pipeFilter} AND ${ownerScope(ctx, 'deal', 'd', query)} ORDER BY d.expected_close_date`);
        break;
      }
      case 'expected-sales': {
        rows = await q(sql`SELECT to_char(date_trunc('month', d.expected_close_date), 'YYYY-MM') AS month, count(*)::int AS deals,
            coalesce(sum(d.amount),0)::text AS amount, coalesce(sum(d.amount * coalesce(d.probability,0) / 100.0),0)::numeric(18,2)::text AS weighted
          FROM deals d WHERE d.workspace_id = ${ws} AND d.deleted_at IS NULL AND d.status = 'open' AND d.expected_close_date IS NOT NULL
            AND d.expected_close_date BETWEEN ${p.from}::date AND ${p.to}::date ${pipeFilter} AND ${ownerScope(ctx, 'deal', 'd', query)}
          GROUP BY 1 ORDER BY 1`);
        break;
      }
      case 'activities-by-user': {
        if (scopeOf(ctx, 'activity', 'view') === 'none') throw forbidden();
        rows = await q(sql`SELECT u.name AS user, count(*) FILTER (WHERE a.status = 'done')::int AS completed,
            count(*) FILTER (WHERE a.status = 'open')::int AS open, count(*) FILTER (WHERE a.status = 'open' AND a.due_at < now())::int AS overdue,
            count(*) FILTER (WHERE a.kind = 'call')::int AS calls, count(*) FILTER (WHERE a.kind = 'meeting')::int AS meetings,
            count(*) FILTER (WHERE a.kind = 'task')::int AS tasks, count(*) FILTER (WHERE a.kind = 'email')::int AS emails
          FROM activities a JOIN users u ON u.id = a.assignee_id
          WHERE a.workspace_id = ${ws} AND a.deleted_at IS NULL AND ${scopeWhere(ctx, 'activity', 'view', 'a', 'assignee_id')}
            AND (a.due_at::date BETWEEN ${p.from}::date AND ${p.to}::date OR a.completed_at::date BETWEEN ${p.from}::date AND ${p.to}::date)
          GROUP BY u.id ORDER BY completed DESC`);
        break;
      }
      case 'product-sales': {
        rows = await q(sql`SELECT li.name AS product, count(DISTINCT d.id)::int AS deals, sum(li.quantity)::text AS quantity, sum(li.line_total)::text AS revenue
          FROM line_items li JOIN deals d ON d.id = li.parent_id AND li.parent_type = 'deal'
          WHERE d.workspace_id = ${ws} AND d.deleted_at IS NULL AND d.status = 'won' AND d.closed_at::date BETWEEN ${p.from}::date AND ${p.to}::date
            ${pipeFilter} AND ${ownerScope(ctx, 'deal', 'd', query)} GROUP BY li.name ORDER BY sum(li.line_total) DESC`);
        break;
      }
      default:
        throw badRequest('Unknown report');
    }
    if (query.format === 'csv') {
      if (scopeOf(ctx, 'deal', 'export') === 'none' && !ctx.isAdmin) throw forbidden('Your role cannot export data');
      return sendCsv(reply, `${req.params.key}-${p.from}-${p.to}`, rows);
    }
    return { period: p, rows: camelAll(rows), totals };
  });
}
