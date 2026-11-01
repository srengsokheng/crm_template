 
import { afterAll, describe, expect, it } from 'vitest';
import { processJobs, processOutbox, sendReminders } from '../src/automation/engine.ts';
import { q, sql } from '../src/db/index.ts';
import { pool } from '../src/db/pool.ts';
import { getApp, inviteUser, signup } from './helpers.ts';

afterAll(async () => { await (await getApp()).close(); await pool.end(); });

const drain = async (now?: Date) => { await processOutbox(); await processJobs(50, now); };

describe('automation', () => {
  it('creates a follow-up task when a deal enters a stage', async () => {
    const { c, dealPipeline, stage } = await signup();
    const rule = await c.post('/automation-rules', {
      entityType: 'deal', pipelineId: dealPipeline.id, stageId: stage(dealPipeline, 'Proposal').id, trigger: 'stage_entered',
      action: 'create_activity', config: { kind: 'task', subject: 'Send proposal for {{title}}', dueInDays: 1, assignTo: 'owner' },
    });
    expect(rule.status).toBe(201);
    const d = (await c.post('/deals', { title: 'Robots', amount: '900' })).body;
    await drain();
    expect((await c.get(`/timeline/deal/${d.id}`)).body.upcoming).toHaveLength(0);
    await c.post(`/deals/${d.id}/move`, { stageId: stage(dealPipeline, 'Proposal').id });
    await drain();
    const tl = (await c.get(`/timeline/deal/${d.id}`)).body;
    expect(tl.upcoming.map((a: any) => a.subject)).toEqual(['Send proposal for Robots']);
    const runs = (await c.get(`/automation-runs/deal/${d.id}`)).body.data;
    expect(runs[0]).toMatchObject({ status: 'success', action: 'create_activity' });
  });

  it('delays rules and skips them if the deal left the stage; respects conditions', async () => {
    const { c, dealPipeline, stage } = await signup();
    await c.post('/automation-rules', {
      entityType: 'deal', pipelineId: dealPipeline.id, stageId: stage(dealPipeline, 'Qualified').id, trigger: 'stage_entered',
      delayMinutes: 60, action: 'add_note', config: { text: 'Still qualified after an hour' },
    });
    await c.post('/automation-rules', {
      entityType: 'deal', pipelineId: dealPipeline.id, trigger: 'created', conditions: [{ field: 'amount', op: 'gt', value: 10000 }],
      action: 'add_note', config: { text: 'Big deal: {{amount}}' },
    });
    const stay = (await c.post('/deals', { title: 'Stays', amount: '50000', stageId: stage(dealPipeline, 'Qualified').id })).body;
    const leave = (await c.post('/deals', { title: 'Leaves', amount: '10', stageId: stage(dealPipeline, 'Qualified').id })).body;
    await drain();
    await c.post(`/deals/${leave.id}/move`, { stageId: stage(dealPipeline, 'Proposal').id });
    const notes = async (id: number) => (await c.get(`/timeline/deal/${id}`)).body.items.filter((i: any) => i.type === 'note').map((i: any) => i.data.body);
    expect(await notes(stay.id)).toEqual(['Big deal: USD 50,000']);
    expect(await notes(leave.id)).toEqual([]);
    await drain(new Date(Date.now() + 61 * 60_000)); // time-travel past the delay
    expect((await notes(stay.id)).sort()).toEqual(['Big deal: USD 50,000', 'Still qualified after an hour']);
    expect(await notes(leave.id)).toEqual([]);
    const runs = (await c.get(`/automation-runs/deal/${leave.id}`)).body.data.map((r: any) => r.status).sort();
    expect(runs).toEqual(['skipped', 'skipped']);
  });

  it('moves stages and assigns owners round-robin without infinite loops', async () => {
    const { c, dealPipeline, stage } = await signup();
    const r1 = await inviteUser(c, 'Sales rep', 'R1');
    const r2 = await inviteUser(c, 'Sales rep', 'R2');
    const team = (await c.post('/teams', { name: 'Round', memberIds: [r1.id, r2.id] })).body;
    await c.post('/automation-rules', { entityType: 'deal', pipelineId: dealPipeline.id, trigger: 'created', action: 'assign_owner', config: { mode: 'round_robin', teamId: team.id } });
    // Ping-pong rules: New → Qualified → New … must stop at the depth guard.
    await c.post('/automation-rules', { entityType: 'deal', pipelineId: dealPipeline.id, stageId: stage(dealPipeline, 'New').id, trigger: 'stage_entered', action: 'move_stage', config: { stageId: stage(dealPipeline, 'Qualified').id } });
    await c.post('/automation-rules', { entityType: 'deal', pipelineId: dealPipeline.id, stageId: stage(dealPipeline, 'Qualified').id, trigger: 'stage_entered', action: 'move_stage', config: { stageId: stage(dealPipeline, 'New').id } });
    const a = (await c.post('/deals', { title: 'A' })).body;
    const b = (await c.post('/deals', { title: 'B' })).body;
    for (let i = 0; i < 12; i++) await drain();
    const owners = [(await c.get(`/deals/${a.id}`)).body.ownerId, (await c.get(`/deals/${b.id}`)).body.ownerId].sort();
    expect(owners).toEqual([r1.id, r2.id].sort());
    const pending = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM outbox_events WHERE processed_at IS NULL`);
    expect(pending[0].n).toBe(0);
    const moves = (await c.get(`/history/deal/${a.id}`)).body.data.filter((h: any) => h.action === 'stage_changed').length;
    expect(moves).toBeLessThanOrEqual(6);
  });

  it('validates rule configuration', async () => {
    const { c, dealPipeline, leadPipeline } = await signup();
    expect((await c.post('/automation-rules', { entityType: 'deal', pipelineId: dealPipeline.id, trigger: 'stage_entered', action: 'add_note', config: { text: 'x' } })).status).toBe(400);
    expect((await c.post('/automation-rules', { entityType: 'deal', pipelineId: leadPipeline.id, trigger: 'created', action: 'add_note', config: { text: 'x' } })).status).toBe(400);
    expect((await c.post('/automation-rules', { entityType: 'deal', pipelineId: dealPipeline.id, trigger: 'created', action: 'create_activity', config: {} })).status).toBe(400);
  });

  it('sends due reminders as notifications', async () => {
    const { c } = await signup();
    const due = new Date(Date.now() + 30 * 60_000).toISOString();
    await c.post('/activities', { kind: 'meeting', subject: 'Demo with Globex', dueAt: due, reminderMinutesBefore: 15 });
    await sendReminders(new Date());
    expect((await c.get('/notifications')).body.unread).toBe(0);
    await sendReminders(new Date(Date.now() + 20 * 60_000));
    const n = (await c.get('/notifications')).body;
    expect(n.unread).toBe(1);
    expect(n.data[0].title).toBe('Reminder: Demo with Globex');
    await sendReminders(new Date(Date.now() + 25 * 60_000));
    expect((await c.get('/notifications')).body.unread).toBe(1); // not sent twice
    await c.post('/notifications/read', {});
    expect((await c.get('/notifications')).body.unread).toBe(0);
  });
});
