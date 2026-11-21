import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.ts';
import { getApp, signup } from './helpers.ts';

afterAll(async () => { await (await getApp()).close(); await pool.end(); });

describe('dashboard period and pipeline', () => {
  it('won and lost counts follow the period', async () => {
    const { c, dealPipeline } = await signup();
    const won = dealPipeline.stages.find((s: any) => s.kind === 'won');
    const d1 = (await c.post('/deals', { title: 'Old win', amount: '100' })).body;
    const d2 = (await c.post('/deals', { title: 'New win', amount: '50' })).body;
    for (const d of [d1, d2]) await c.post(`/deals/${d.id}/move`, { stageId: won.id });
    await pool.query(`UPDATE deals SET closed_at = '2026-03-10T12:00:00Z' WHERE id = $1`, [d1.id]);
    await pool.query(`UPDATE deals SET closed_at = '2026-11-05T12:00:00Z' WHERE id = $1`, [d2.id]);
    const kpis = async (from: string, to: string) => (await c.get(`/dashboard?from=${from}&to=${to}`)).body.kpis;
    expect(await kpis('2026-01-01', '2026-03-31')).toMatchObject({ wonCount: 1, wonAmount: '100.00' });
    expect(await kpis('2026-11-01', '2026-11-30')).toMatchObject({ wonCount: 1, wonAmount: '50.00' });
    expect(await kpis('2026-01-01', '2026-12-31')).toMatchObject({ wonCount: 2, wonAmount: '150.00' });
    expect((await c.get('/dashboard?from=2026-12-01&to=2026-11-01')).status).toBe(400);
  });

  it('only this workspace’s deal pipelines', async () => {
    const a = await signup();
    const b = await signup();
    expect((await a.c.get(`/dashboard?pipelineId=${a.dealPipeline.id}`)).body.pipelineId).toBe(a.dealPipeline.id);
    // Another workspace's pipeline (its stage names would show) and a lead pipeline are refused.
    expect((await a.c.get(`/dashboard?pipelineId=${b.dealPipeline.id}`)).status).toBe(404);
    expect((await a.c.get(`/dashboard?pipelineId=${a.leadPipeline.id}`)).status).toBe(404);
  });
});
