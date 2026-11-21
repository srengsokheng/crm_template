import { afterAll, describe, expect, it } from 'vitest';
import { processJobs, processOutbox } from '../src/automation/engine.ts';
import { q, sql } from '../src/db/index.ts';
import { pool } from '../src/db/pool.ts';
import { getApp, inviteUser, signup } from './helpers.ts';

afterAll(async () => { await (await getApp()).close(); await pool.end(); });
const drain = async (now?: Date) => { for (let i = 0; i < 20; i++) if (!((await processOutbox()) + (await processJobs(50, now)))) return; };

describe('"field changed" trigger', () => {
  it('runs when the chosen field changes, not for other fields', async () => {
    const { c, dealPipeline } = await signup();
    const rule = await c.post('/automation-rules', {
      entityType: 'deal', pipelineId: dealPipeline.id, trigger: 'field_changed', triggerField: 'amount',
      action: 'add_note', config: { text: 'Amount is now {{amount}}' },
    });
    expect(rule.status, JSON.stringify(rule.body)).toBe(201);
    expect(rule.body).toMatchObject({ trigger: 'field_changed', triggerField: 'amount' });
    const d = (await c.post('/deals', { title: 'Robots', amount: '100' })).body;
    await drain();
    const notes = async () => (await c.get(`/timeline/deal/${d.id}`)).body.items.filter((i: any) => i.type === 'note').map((n: any) => n.data.body);
    expect(await notes()).toEqual([]); // creating isn't a change
    await c.patch(`/deals/${d.id}`, { title: 'Robots v2' });
    await drain();
    expect(await notes()).toEqual([]); // another field
    await c.patch(`/deals/${d.id}`, { amount: '2500' });
    await drain();
    expect(await notes()).toEqual(['Amount is now USD 2,500']);
  });

  it('works for custom fields and only while in the chosen stage', async () => {
    const { c, dealPipeline, stage } = await signup();
    const f = (await c.post('/fields', { entityType: 'deal', label: 'Risk', type: 'select', options: [{ id: 'hi', label: 'High' }, { id: 'lo', label: 'Low' }] })).body;
    await c.post('/automation-rules', {
      entityType: 'deal', pipelineId: dealPipeline.id, stageId: stage(dealPipeline, 'Proposal').id, trigger: 'field_changed',
      triggerField: `custom.${f.key}`, action: 'notify', config: { title: 'Risk changed on {{title}}', userId: 'owner' },
    });
    const inNew = (await c.post('/deals', { title: 'In New' })).body;
    const inProposal = (await c.post('/deals', { title: 'In Proposal', stageId: stage(dealPipeline, 'Proposal').id })).body;
    await c.patch(`/deals/${inNew.id}`, { custom: { [f.key]: 'hi' } });
    await c.patch(`/deals/${inProposal.id}`, { custom: { [f.key]: 'hi' } });
    await drain();
    const titles = (await c.get('/notifications')).body.data.map((n: any) => n.title);
    expect(titles).toContain('Risk changed on In Proposal');
    expect(titles).not.toContain('Risk changed on In New');
  });

  it('validates the trigger field and refuses rules that would trigger themselves', async () => {
    const { c, dealPipeline } = await signup();
    const base = { entityType: 'deal', pipelineId: dealPipeline.id, trigger: 'field_changed', action: 'add_note', config: { text: 'x' } };
    expect((await c.post('/automation-rules', base)).body.error.message).toBe('Choose the field that triggers this rule');
    expect((await c.post('/automation-rules', { ...base, triggerField: 'password_hash' })).status).toBe(400);
    expect((await c.post('/automation-rules', { ...base, triggerField: 'custom.nope' })).status).toBe(400);
    const self = await c.post('/automation-rules', { ...base, triggerField: 'probability', action: 'update_field', config: { field: 'probability', value: 50 } });
    expect(self.body.error.message).toBe('A rule can’t change the field that triggers it');
  });

  it('stops chains that bounce between rules (loop guard)', async () => {
    const { c, dealPipeline } = await signup();
    await c.post('/automation-rules', { entityType: 'deal', pipelineId: dealPipeline.id, trigger: 'field_changed', triggerField: 'probability', action: 'update_field', config: { field: 'description', value: 'ping' } });
    await c.post('/automation-rules', { entityType: 'deal', pipelineId: dealPipeline.id, trigger: 'field_changed', triggerField: 'description', action: 'update_field', config: { field: 'probability', value: 42 } });
    const d = (await c.post('/deals', { title: 'Loop' })).body;
    await c.patch(`/deals/${d.id}`, { probability: 55 }); // new deals start at the stage's 10%
    await drain();
    const runs = (await c.get(`/automation-runs/deal/${d.id}`)).body.data;
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.length).toBeLessThanOrEqual(6); // bounded, not endless
  });
});

describe('working-hours delays', () => {
  it('schedules delays in working time using the workspace time zone and hours', async () => {
    const { c, dealPipeline } = await signup();
    const ws = await c.patch('/workspace', { timezone: 'Asia/Phnom_Penh', workingHours: { days: [1, 2, 3, 4, 5], start: '08:00', end: '12:00' } });
    expect(ws.status).toBe(200);
    expect((await c.get('/auth/me')).body.workspace).toMatchObject({ timezone: 'Asia/Phnom_Penh', workingHours: { start: '08:00', end: '12:00' } });
    const r = (await c.post('/automation-rules', {
      entityType: 'deal', pipelineId: dealPipeline.id, trigger: 'created', delayMinutes: 600, businessHours: true, action: 'add_note', config: { text: 'Later' },
    })).body;
    expect(r.businessHours).toBe(true);
    await c.post('/deals', { title: 'Timed' });
    await processOutbox();
    const [run] = await q<{ scheduled_for: Date; created_at: Date }>(sql`SELECT scheduled_for, now() AS created_at FROM automation_runs WHERE rule_id = ${r.id}`);
    // 10 working hours with 4-hour days is at least 2 extra calendar days away, unlike a plain 10-hour delay.
    const hours = (run.scheduled_for.getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(24);
    const local = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Phnom_Penh', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' }).format(run.scheduled_for);
    expect(local).toMatch(/^(Mon|Tue|Wed|Thu|Fri) (0[89]|1[01]):\d\d$|^(Mon|Tue|Wed|Thu|Fri) 12:00$/);
  });

  it('validates working hours and time zone (admins only)', async () => {
    const { c } = await signup();
    expect((await c.patch('/workspace', { timezone: 'Mars/Olympus' })).status).toBe(400);
    expect((await c.patch('/workspace', { workingHours: { days: [1], start: '17:00', end: '09:00' } })).status).toBe(400);
    expect((await c.patch('/workspace', { workingHours: { days: [8], start: '09:00', end: '17:00' } })).status).toBe(400);
    const rep = await inviteUser(c, 'Sales rep');
    expect((await rep.c.patch('/workspace', { timezone: 'UTC' })).status).toBe(403);
    // Saving hours keeps other settings.
    await c.patch('/workspace', { useLeads: false });
    await c.patch('/workspace', { workingHours: { days: [1, 2], start: '10:00', end: '16:00' } });
    expect((await c.get('/auth/me')).body.workspace.useLeads).toBe(false);
  });
});
