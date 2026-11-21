import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.ts';
import { getApp, signup } from './helpers.ts';

afterAll(async () => { await (await getApp()).close(); await pool.end(); });

/** A PATCH changes only what it sends (zod 4's .partial() used to fill in defaults for the rest). */
describe('PATCH keeps the fields it was not sent', () => {
  it('product: renaming keeps the price and unit', async () => {
    const { c } = await signup();
    const p = (await c.post('/products', { name: 'Arm', unitPrice: '1200', unit: 'set' })).body;
    expect((await c.patch(`/products/${p.id}`, { name: 'Robot arm' })).status).toBe(200);
    expect((await c.get(`/products/${p.id}`)).body).toMatchObject({ name: 'Robot arm', unitPrice: '1200.00', unit: 'set' });
  });

  it('stage: renaming keeps the colour and kind (won stays won)', async () => {
    const { c, dealPipeline } = await signup();
    const won = dealPipeline.stages.find((s: any) => s.kind === 'won');
    expect((await c.patch(`/stages/${won.id}`, { name: 'Closed won' })).status).toBe(200);
    const after = (await c.get('/meta')).body.pipelines.find((p: any) => p.id === dealPipeline.id).stages.find((s: any) => s.id === won.id);
    expect(after).toMatchObject({ name: 'Closed won', kind: 'won', color: won.color });
  });

  it('custom field: relabelling keeps the options and the required rule', async () => {
    const { c } = await signup();
    const f = (await c.post('/fields', { entityType: 'deal', label: 'Segment', type: 'select', required: 'always',
      options: [{ id: 'smb', label: 'SMB' }, { id: 'ent', label: 'Enterprise' }] })).body;
    expect((await c.patch(`/fields/${f.id}`, { label: 'Customer segment' })).status).toBe(200);
    const after = (await c.get('/meta')).body.fields.find((x: any) => x.id === f.id);
    expect(after).toMatchObject({ label: 'Customer segment', required: 'always' });
    expect(after.options.map((o: any) => o.id)).toEqual(['smb', 'ent']);
  });

  it('automation rule: switching it off keeps its delay, conditions and settings', async () => {
    const { c, dealPipeline } = await signup();
    const r = (await c.post('/automation-rules', { entityType: 'deal', pipelineId: dealPipeline.id, trigger: 'created', action: 'add_note',
      delayMinutes: 60, conditions: [{ field: 'amount', op: 'gt', value: 100 }], config: { text: 'Big one' } })).body;
    expect((await c.patch(`/automation-rules/${r.id}`, { isEnabled: false })).status).toBe(200);
    const after = (await c.get(`/automation-rules?pipelineId=${dealPipeline.id}`)).body.data.find((x: any) => x.id === r.id);
    expect(after).toMatchObject({ isEnabled: false, delayMinutes: 60, config: { text: 'Big one' }, conditions: [{ field: 'amount', op: 'gt', value: 100 }] });
  });
});
