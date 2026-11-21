import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.ts';
import { boardLimits } from '../src/lib/list.ts';
import { getApp, signup } from './helpers.ts';

afterAll(async () => { await (await getApp()).close(); await pool.end(); });

const perStage = (rows: { stageId: number }[]) => rows.reduce<Record<number, number>>((m, r) => ({ ...m, [r.stageId]: (m[r.stageId] ?? 0) + 1 }), {});

describe('Kanban "Show more" (per-column limits)', () => {
  it('parses and caps the limits', () => {
    expect(boardLimits({})).toEqual({ limit: 50, stageIds: [], limits: [] });
    expect(boardLimits({ limit: '9999', more: '7:100' })).toEqual({ limit: 500, stageIds: [7], limits: [500] });
    // Never below the default, never above 500; junk ignored.
    expect(boardLimits({ more: '1:10,2:100,3:9999,x:1,4:,;DROP' })).toEqual({ limit: 50, stageIds: [1, 2, 3], limits: [50, 100, 500] });
  });

  it('deals: one column shows more, the others keep the default; counts stay whole', async () => {
    const { c, dealPipeline } = await signup();
    const [a, b] = dealPipeline.stages.filter((s: any) => s.kind === 'open');
    for (let i = 0; i < 5; i++) await c.post('/deals', { title: `A${i}`, pipelineId: dealPipeline.id, stageId: a.id });
    for (let i = 0; i < 3; i++) await c.post('/deals', { title: `B${i}`, pipelineId: dealPipeline.id, stageId: b.id });
    const base = (await c.get(`/deals/board?pipelineId=${dealPipeline.id}&limit=2`)).body;
    expect(perStage(base.deals)).toEqual({ [a.id]: 2, [b.id]: 2 });
    expect(base.stats.find((s: any) => s.stageId === a.id).count).toBe(5);
    const more = (await c.get(`/deals/board?pipelineId=${dealPipeline.id}&limit=2&more=${a.id}:4`)).body;
    expect(perStage(more.deals)).toEqual({ [a.id]: 4, [b.id]: 2 });
    // Newest-moved first, and the extra cards continue the same order.
    expect(more.deals.filter((d: any) => d.stageId === a.id).slice(0, 2).map((d: any) => d.id)).toEqual(base.deals.filter((d: any) => d.stageId === a.id).map((d: any) => d.id));
  });

  it('leads: the same', async () => {
    const { c, leadPipeline } = await signup();
    const [a] = leadPipeline.stages.filter((s: any) => s.kind === 'open');
    for (let i = 0; i < 4; i++) await c.post('/leads', { title: `L${i}`, stageId: a.id });
    expect((await c.get('/leads/board?limit=1')).body.leads).toHaveLength(1);
    expect((await c.get(`/leads/board?limit=1&more=${a.id}:3`)).body.leads).toHaveLength(3);
  });
});
