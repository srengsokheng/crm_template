import { afterAll, describe, expect, it } from 'vitest';
import { q, sql } from '../src/db/index.ts';
import { pool } from '../src/db/pool.ts';
import { getApp, inviteUser, signup } from './helpers.ts';

afterAll(async () => { await (await getApp()).close(); await pool.end(); });
const today = new Date().toISOString().slice(0, 10);

describe('multi-currency reporting', () => {
  it('converts other currencies to the base currency in sums, and warns about missing rates', async () => {
    const { c } = await signup(); // base USD
    await c.post('/deals', { title: 'USD deal', amount: '1000' });
    await c.post('/deals', { title: 'EUR deal', amount: '1000', currency: 'EUR' });
    await c.post('/deals', { title: 'KHR deal', amount: '4000000', currency: 'KHR' });

    // No rates yet: only USD is counted, and the gaps are named.
    let dash = (await c.get('/dashboard')).body;
    expect(dash.kpis.openAmount).toBe('1000.00');
    expect(dash.missingRates).toEqual(['EUR', 'KHR']);
    expect((await c.get('/exchange-rates')).body.missing).toEqual(['EUR', 'KHR']);

    expect((await c.post('/exchange-rates', { currency: 'eur', rate: '1.10', validFrom: '2020-01-01' })).status).toBe(201);
    await c.post('/exchange-rates', { currency: 'KHR', rate: '0.00025', validFrom: '2020-01-01' });
    dash = (await c.get('/dashboard')).body;
    expect(dash.kpis.openAmount).toBe('3100.00'); // 1000 + 1100 + 1000 (4,000,000 KHR × 0.00025)
    expect(dash.missingRates).toEqual([]);
    expect((await c.get('/deals?view=list')).body.aggregates.amountSum).toBe('3100.00');
    const board = (await c.get('/deals/board')).body;
    expect(board.stats.reduce((a: number, s: any) => a + Number(s.sum), 0)).toBe(3100);
    const byStage = (await c.get('/reports/deals-by-stage?preset=year')).body;
    expect(Number(byStage.totals.amount)).toBe(3100);
  });

  it('uses the rate valid at the time: today for open deals, the close date for won deals', async () => {
    const { c, dealPipeline, stage } = await signup();
    await c.post('/exchange-rates', { currency: 'EUR', rate: '1.00', validFrom: '2020-01-01' });
    await c.post('/exchange-rates', { currency: 'EUR', rate: '2.00', validFrom: today });
    const won = (await c.post('/deals', { title: 'Old win', amount: '100', currency: 'EUR' })).body;
    await c.post(`/deals/${won.id}/move`, { stageId: stage(dealPipeline, 'Won').id });
    await q(sql`UPDATE deals SET closed_at = '2021-06-01' WHERE id = ${won.id}`);
    await c.post('/deals', { title: 'Open', amount: '100', currency: 'EUR' });
    const report = (await c.get('/reports/won-deals?from=2021-01-01&to=2021-12-31')).body;
    expect(report.rows[0]).toMatchObject({ amount: '100.00', currency: 'EUR', amountInBase: '100.00' }); // 2021 rate
    expect(report.totals.amount).toBe('100.00');
    expect((await c.get('/dashboard')).body.kpis.openAmount).toBe('200.00'); // today's rate
    const rates = (await c.get('/exchange-rates')).body.data;
    expect(rates.map((r: any) => [r.rate, r.current])).toEqual([['2.00000000', true], ['1.00000000', false]]);
  });

  it('validates rates and lets only admins change them; workspaces are separate', async () => {
    const { c } = await signup();
    expect((await c.post('/exchange-rates', { currency: 'USD', rate: '1', validFrom: today })).body.error.message).toMatch(/base currency/);
    expect((await c.post('/exchange-rates', { currency: 'EURO', rate: '1', validFrom: today })).status).toBe(400);
    expect((await c.post('/exchange-rates', { currency: 'EUR', rate: '0', validFrom: today })).status).toBe(400);
    expect((await c.post('/exchange-rates', { currency: 'EUR', rate: '-1', validFrom: today })).status).toBe(400);
    const r = (await c.post('/exchange-rates', { currency: 'EUR', rate: '1.1', validFrom: today })).body;
    expect((await c.post('/exchange-rates', { currency: 'EUR', rate: '1.2', validFrom: today })).body.rate).toBe('1.20000000'); // same day replaces
    const rep = await inviteUser(c, 'Manager');
    expect((await rep.c.post('/exchange-rates', { currency: 'GBP', rate: '1.3', validFrom: today })).status).toBe(403);
    expect((await rep.c.del(`/exchange-rates/${r.id}`)).status).toBe(403);
    expect((await rep.c.get('/exchange-rates')).status).toBe(200);
    const other = await signup('Other');
    expect((await other.c.get('/exchange-rates')).body.data).toEqual([]);
    expect((await other.c.del(`/exchange-rates/${r.id}`)).status).toBe(404);
    expect((await c.del(`/exchange-rates/${r.id}`)).status).toBe(204);
  });
});
