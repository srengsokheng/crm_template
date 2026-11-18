/**
 * Sales targets: what each person (and the whole team) should win in a month, in the base currency, against deals
 * won that month (converted the same way as the dashboard's "Won this month").
 *
 * Who sees whom follows deal permissions: people with "all" deals see everyone, "team" their team, "own" themselves.
 * Only admins set targets (Settings → Sales targets).
 */
import type { FastifyInstance } from 'fastify';
import { targetMonthSchema, targetsUpdateSchema } from '@crm/shared';
import { q, q1, sql, tx } from '../db/index.ts';
import type { Ctx } from '../lib/context.ts';
import { dealInBase } from '../lib/currency.ts';
import { ctxOf } from '../lib/http.ts';
import { requireAdmin, scopeOf, scopeWhere } from '../lib/permissions.ts';
import { assertMembers } from '../lib/records.ts';
import { parse } from '../lib/validate.ts';

/** First and last day of a month "YYYY-MM" (default: this month). */
function monthBounds(m: string | undefined) {
  const month = m ?? new Date().toISOString().slice(0, 7);
  const [y, mo] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return { month, from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

/** The people this user may see progress for (active members), per their deal view scope. */
async function visiblePeople(ctx: Ctx) {
  const scope = ctx.isAdmin ? 'all' : scopeOf(ctx, 'deal', 'view');
  if (scope === 'none') return [];
  const ids = scope === 'all' ? null : scope === 'team' ? ctx.teamUserIds : [ctx.userId];
  return q<{ id: number; name: string }>(sql`SELECT u.id, u.name FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.workspace_id = ${ctx.workspaceId} AND m.status = 'active' ${ids ? sql`AND u.id = ANY(${ids})` : sql``} ORDER BY u.name`);
}

export async function targetRoutes(app: FastifyInstance) {
  app.get('/targets', async (req) => {
    const ctx = ctxOf(req);
    const b = monthBounds(req.query && (req.query as { month?: string }).month ? parse(targetMonthSchema, (req.query as { month: string }).month) : undefined);
    const people = await visiblePeople(ctx);
    const canDeals = ctx.isAdmin || scopeOf(ctx, 'deal', 'view') !== 'none';
    const won = canDeals ? await q<{ owner_id: number; won: string; count: number }>(sql`
      SELECT d.owner_id, coalesce(sum(${dealInBase(ctx)}), 0)::numeric(18,2)::text AS won, count(*)::int AS count
      FROM deals d WHERE d.workspace_id = ${ctx.workspaceId} AND d.deleted_at IS NULL AND d.status = 'won'
        AND d.closed_at::date BETWEEN ${b.from}::date AND ${b.to}::date AND ${scopeWhere(ctx, 'deal', 'view', 'd')}
      GROUP BY d.owner_id`) : [];
    const targets = await q<{ user_id: number | null; amount: string }>(sql`SELECT user_id, amount::text FROM sales_targets
      WHERE workspace_id = ${ctx.workspaceId} AND month = ${b.from}::date`);
    const targetOf = (uid: number | null) => targets.find((t) => t.user_id === uid)?.amount ?? null;
    const pct = (w: string, t: string | null) => (t ? Math.round((Number(w) / Number(t)) * 100) : null);
    const rows = people.map((p) => {
      const w = won.find((x) => x.owner_id === p.id);
      const target = targetOf(p.id);
      return { userId: p.id, name: p.name, target, won: w?.won ?? '0.00', wonCount: w?.count ?? 0, pct: pct(w?.won ?? '0', target) };
    });
    rows.sort((a, b2) => (b2.pct ?? -1) - (a.pct ?? -1) || Number(b2.won) - Number(a.won) || a.name.localeCompare(b2.name));
    const teamWon = won.reduce((s, x) => s + Number(x.won), 0).toFixed(2);
    const teamTarget = targetOf(null);
    return {
      month: b.month, baseCurrency: ctx.baseCurrency, canEdit: ctx.isAdmin,
      team: { target: teamTarget, won: teamWon, wonCount: won.reduce((s, x) => s + x.count, 0), pct: pct(teamWon, teamTarget) },
      people: rows,
      me: rows.find((r) => r.userId === ctx.userId) ?? null,
    };
  });

  /** Admins: set, change or remove targets for a month (null amount removes). */
  app.put('/targets', async (req) => {
    const ctx = ctxOf(req);
    requireAdmin(ctx);
    const body = parse(targetsUpdateSchema, req.body);
    await assertMembers(ctx, body.targets.map((t) => t.userId));
    const { from } = monthBounds(body.month);
    await tx(async (db) => {
      for (const t of body.targets) {
        await q(sql`DELETE FROM sales_targets WHERE workspace_id = ${ctx.workspaceId} AND month = ${from}::date
          AND coalesce(user_id, 0) = ${t.userId ?? 0}`, db);
        if (t.amount !== null) {
          await q(sql`INSERT INTO sales_targets (workspace_id, month, user_id, amount, updated_by)
            VALUES (${ctx.workspaceId}, ${from}::date, ${t.userId}, ${t.amount}, ${ctx.userId})`, db);
        }
      }
    });
    const n = await q1<{ n: number }>(sql`SELECT count(*)::int AS n FROM sales_targets WHERE workspace_id = ${ctx.workspaceId} AND month = ${from}::date`);
    return { month: body.month, count: n?.n ?? 0 };
  });
}
