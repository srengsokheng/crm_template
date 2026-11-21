/** Exchange rates to the workspace base currency (Settings → Currencies). Admins manage them; everyone may read. */
import type { FastifyInstance } from 'fastify';
import { exchangeRateSchema } from '@crm/shared';
import { q, q1, sql } from '../db/index.ts';
import { missingRates } from '../lib/currency.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { ctxOf } from '../lib/http.ts';
import { requireAdmin } from '../lib/permissions.ts';
import { camelAll } from '../lib/records.ts';
import { parse } from '../lib/validate.ts';

export async function rateRoutes(app: FastifyInstance) {
  app.get('/exchange-rates', async (req) => {
    const ctx = ctxOf(req);
    const rows = await q(sql`SELECT r.id, r.currency, r.rate_to_base::text AS rate, r.valid_from, r.created_at, u.name AS created_by_name,
        (r.valid_from = (SELECT max(valid_from) FROM exchange_rates x WHERE x.workspace_id = r.workspace_id AND x.currency = r.currency AND x.valid_from <= current_date)) AS current
      FROM exchange_rates r LEFT JOIN users u ON u.id = r.created_by
      WHERE r.workspace_id = ${ctx.workspaceId} ORDER BY r.currency, r.valid_from DESC`);
    return { baseCurrency: ctx.baseCurrency, data: camelAll(rows), missing: await missingRates(ctx) };
  });

  app.post('/exchange-rates', async (req, reply) => {
    const ctx = ctxOf(req);
    requireAdmin(ctx);
    const body = parse(exchangeRateSchema, req.body);
    if (body.currency === ctx.baseCurrency) throw badRequest(`${body.currency} is the base currency; it doesn't need a rate`, { currency: 'Base currency' });
    const row = await q1(sql`INSERT INTO exchange_rates (workspace_id, currency, rate_to_base, valid_from, created_by)
      VALUES (${ctx.workspaceId}, ${body.currency}, ${body.rate}, ${body.validFrom}, ${ctx.userId})
      ON CONFLICT (workspace_id, currency, valid_from) DO UPDATE SET rate_to_base = EXCLUDED.rate_to_base, created_by = EXCLUDED.created_by, created_at = now()
      RETURNING id, currency, rate_to_base::text AS rate, valid_from`);
    return reply.code(201).send(row);
  });

  app.delete<{ Params: { id: string } }>('/exchange-rates/:id', async (req, reply) => {
    const ctx = ctxOf(req);
    requireAdmin(ctx);
    const r = await q1(sql`DELETE FROM exchange_rates WHERE id = ${Number(req.params.id)} AND workspace_id = ${ctx.workspaceId} RETURNING id`);
    if (!r) throw notFound('Rate');
    return reply.code(204).send();
  });
}
