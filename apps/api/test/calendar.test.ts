import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.ts';
import { getApp, inviteUser, signup } from './helpers.ts';

afterAll(async () => { await (await getApp()).close(); await pool.end(); });

const range = 'from=2026-12-01T00:00:00Z&to=2027-01-01T00:00:00Z&fromDate=2026-12-01&toDate=2026-12-31';

describe('calendar', () => {
  it('activities by due time and open deals by expected close, in range, with totals', async () => {
    const { c } = await signup();
    await c.post('/activities', { kind: 'call', subject: 'In range', dueAt: '2026-12-10T09:00:00Z' });
    await c.post('/activities', { kind: 'task', subject: 'Too late', dueAt: '2027-01-02T09:00:00Z' });
    await c.post('/activities', { kind: 'task', subject: 'No date' });
    await c.post('/deals', { title: 'Closes in Dec', expectedCloseDate: '2026-12-20' });
    await c.post('/deals', { title: 'Closes in Jan', expectedCloseDate: '2027-01-20' });
    const r = (await c.get(`/calendar?${range}`)).body;
    expect(r.activities.map((a: any) => a.subject)).toEqual(['In range']);
    expect(r.deals.map((d: any) => [d.title, d.expectedCloseDate])).toEqual([['Closes in Dec', '2026-12-20']]);
    expect([r.activitiesTotal, r.dealsTotal, r.cap]).toEqual([1, 1, 500]);
    expect((await c.get(`/calendar?${range}&show=deals`)).body.activities).toEqual([]);
  });

  it('validates the range', async () => {
    const { c } = await signup();
    expect((await c.get('/calendar')).status).toBe(400);
    expect((await c.get('/calendar?from=2026-12-01T00:00:00Z&to=2027-03-01T00:00:00Z&fromDate=2026-12-01&toDate=2027-02-28')).status).toBe(400);
    expect((await c.get('/calendar?from=2026-12-02T00:00:00Z&to=2026-12-01T00:00:00Z&fromDate=2026-12-01&toDate=2026-12-01')).status).toBe(400);
  });

  it('mine by default; everyone only within what the role may see; other workspaces never', async () => {
    const { c } = await signup();
    const { c: rep } = await inviteUser(c, 'Sales rep');
    await c.post('/activities', { kind: 'call', subject: 'Admin call', dueAt: '2026-12-10T09:00:00Z' });
    await c.post('/deals', { title: 'Admin deal', expectedCloseDate: '2026-12-20' });
    await rep.post('/activities', { kind: 'call', subject: 'Rep call', dueAt: '2026-12-11T09:00:00Z' });
    await rep.post('/deals', { title: 'Rep deal', expectedCloseDate: '2026-12-21' });
    const mine = (await rep.get(`/calendar?${range}`)).body;
    expect([mine.activities.map((a: any) => a.subject), mine.deals.map((d: any) => d.title)]).toEqual([['Rep call'], ['Rep deal']]);
    const all = (await rep.get(`/calendar?${range}&assigneeId=all`)).body;
    const dealsList = (await rep.get('/deals?closeFrom=2026-12-01&closeTo=2026-12-31')).body.data.map((d: any) => d.title).sort();
    expect(all.deals.map((d: any) => d.title).sort()).toEqual(dealsList);
    expect((await c.get(`/calendar?${range}&assigneeId=all`)).body.deals.map((d: any) => d.title).sort()).toEqual(['Admin deal', 'Rep deal']);
    const other = await signup();
    expect((await other.c.get(`/calendar?${range}&assigneeId=all`)).body).toMatchObject({ activities: [], deals: [] });
  });
});
