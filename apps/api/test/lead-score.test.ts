import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.ts';
import { getApp, signup } from './helpers.ts';

afterAll(async () => { await (await getApp()).close(); await pool.end(); });

describe('lead score', () => {
  it('fit + engagement, explained on the lead; sort and filter by tier', async () => {
    const { c, leadPipeline } = await signup();
    const bare = (await c.post('/leads', { title: 'Bare' })).body;
    const rich = (await c.post('/leads', { title: 'Rich', firstName: 'Dara', companyName: 'Umbrella', jobTitle: 'Buyer', amount: '5000',
      methods: [{ kind: 'email', value: 'dara@umbrella.test' }, { kind: 'phone', value: '+855 12 345 678' }] })).body;
    // Engagement: two done activities, an open one, a note, moved to the second stage.
    for (const subject of ['Call', 'Demo']) {
      const a = (await c.post('/activities', { kind: 'call', subject, links: [{ entityType: 'lead', entityId: rich.id }] })).body;
      await c.patch(`/activities/${a.id}`, { status: 'done' });
    }
    await c.post('/activities', { kind: 'task', subject: 'Send quote', dueAt: new Date(Date.now() + 864e5).toISOString(), links: [{ entityType: 'lead', entityId: rich.id }] });
    await c.post('/notes', { entityType: 'lead', entityId: rich.id, body: 'Wants 3 arms' });
    const second = leadPipeline.stages.filter((s: any) => s.kind === 'open')[1];
    await c.post(`/leads/${rich.id}/move`, { stageId: second.id });

    const r = (await c.get(`/leads/${rich.id}`)).body;
    expect(r.scoreParts).toEqual({ email: 10, phone: 10, company: 10, title: 5, value: 15, done: 10, next: 10, notes: 5, stage: 10 });
    expect(r.score).toBe(85);
    expect((await c.get(`/leads/${bare.id}`)).body.score).toBe(0);

    const list = (await c.get('/leads?sort=-score')).body.data;
    expect(list.map((l: any) => [l.title, l.score])).toEqual([['Rich', 85], ['Bare', 0]]);
    expect((await c.get('/leads?tier=hot')).body.data.map((l: any) => l.title)).toEqual(['Rich']);
    expect((await c.get('/leads?tier=cold')).body.data.map((l: any) => l.title)).toEqual(['Bare']);
    expect((await c.get('/leads?tier=warm')).body.total).toBe(0);
    // On the board too.
    expect((await c.get('/leads/board')).body.leads.find((l: any) => l.id === rich.id).score).toBe(85);
  });
});
