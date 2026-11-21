/**
 * Multi-currency sums. Amounts are converted to the workspace base currency with the newest admin-entered rate valid
 * on the given day (`crm_to_base` in migration 0011). Amounts without a rate become NULL, so they are left out of
 * sums instead of being added in the wrong currency; `missingRates` lists those currencies for a warning.
 */
import { q, raw, sql, type Fragment } from '../db/index.ts';
import type { Ctx } from './context.ts';

/** SQL: `${alias}.${col}` in the base currency, converted at `at` (default: today; closed deals use close date). */
export function inBase(ctx: Ctx, alias: string, opts: { col?: string; at?: Fragment } = {}): Fragment {
  const at = opts.at ?? sql`current_date`;
  return sql`crm_to_base(${raw(`${alias}.${opts.col ?? 'amount'}`)}, ${raw(`${alias}.currency`)}, ${ctx.baseCurrency}::char(3), ${ctx.workspaceId}::bigint, ${at})`;
}

/** Deals are valued at their close date once closed, otherwise today. */
export const dealInBase = (ctx: Ctx, alias = 'd') => inBase(ctx, alias, { at: sql`coalesce(${raw(`${alias}.closed_at`)}, now())::date` });

/** Currencies used by live deals/leads that have no rate to the base currency yet. */
export async function missingRates(ctx: Ctx): Promise<string[]> {
  const rows = await q<{ currency: string }>(sql`
    SELECT DISTINCT x.currency FROM (
      SELECT currency FROM deals WHERE workspace_id = ${ctx.workspaceId} AND deleted_at IS NULL AND amount IS NOT NULL
      UNION SELECT currency FROM leads WHERE workspace_id = ${ctx.workspaceId} AND deleted_at IS NULL AND amount IS NOT NULL
    ) x
    WHERE x.currency <> ${ctx.baseCurrency}
      AND NOT EXISTS (SELECT 1 FROM exchange_rates r WHERE r.workspace_id = ${ctx.workspaceId} AND r.currency = x.currency)
    ORDER BY 1`);
  return rows.map((r) => r.currency);
}
