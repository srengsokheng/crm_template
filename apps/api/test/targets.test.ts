import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.ts';
import { getApp, inviteUser, signup } from './helpers.ts';

afterAll(async () => { await (await getApp()).close(); await pool.end(); });

const month = new Date().toISOString().slice(0, 7);
const lastMonth = (() => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); })();

/** A deal owned by `ownerId`, won now (or on a given date). */
async function wonDeal(c: any, ownerId: number, amount: string, closedAt?: string, currency = 'USD') {
  const d = (await c.post('/deals', { title: `Deal ${amount}`, amount, currency, ownerId })).body;
  expect((await c.post(`/deals/${d.id}/close`, { outcome: 'won' })).status).toBe(200);
  if (closedAt) await pool.query('UPDATE deals SET closed_at = $1 WHERE id = $2', [closedAt, d.id]);
  return d;
}

describe('sales targets', () => {
  it('admins set monthly targets; progress counts deals won that month, in the base currency', async () => {
    const { c, me } = await signup();
    const rita = await inviteUser(c, 'Sales rep', 'Rita');
    const otto = await inviteUser(c, 'Sales rep', 'Otto');
    const put = await c.put('/targets', { month, targets: [{ userId: rita.id, amount: '10000' }, { userId: otto.id, amount: '5000' }, { userId: null, amount: '20000' }] });
    expect(put.body).toEqual({ month, count: 3 });

    await wonDeal(c, rita.id, '4000');
    await wonDeal(c, rita.id, '2500.50');
    await wonDeal(c, rita.id, '9999', `${lastMonth}-15T10:00:00Z`); // last month: not counted
    await wonDeal(c, otto.id, '6000');
    const lost = (await c.post('/deals', { title: 'Lost one', amount: '7000', ownerId: otto.id })).body;
    await c.post(`/deals/${lost.id}/close`, { outcome: 'lost' });

    const t = (await c.get(`/targets?month=${month}`)).body;
    expect(t).toMatchObject({ month, baseCurrency: 'USD', canEdit: true, team: { target: '20000.00', won: '12500.50', wonCount: 3, pct: 63 } });
    expect(t.people.map((p: any) => [p.name, p.target, p.won, p.wonCount, p.pct])).toEqual([
      ['Otto', '5000.00', '6000.00', 1, 120], // over target first
      ['Rita', '10000.00', '6500.50', 2, 65],
      ['Admin', null, '0.00', 0, null],
    ]);
    expect(t.me).toMatchObject({ userId: me.user.id, target: null });

    // Last month: its own targets (none) and its own wins.
    const lm = (await c.get(`/targets?month=${lastMonth}`)).body;
    expect(lm.team).toMatchObject({ target: null, won: '9999.00', pct: null });

    // Change and remove.
    await c.put('/targets', { month, targets: [{ userId: otto.id, amount: null }, { userId: rita.id, amount: '6500.50' }] });
    const after = (await c.get(`/targets?month=${month}`)).body.people;
    expect(after.find((p: any) => p.name === 'Rita')).toMatchObject({ target: '6500.50', pct: 100 });
    expect(after.find((p: any) => p.name === 'Otto')).toMatchObject({ target: null, pct: null });
  });

  it('people see progress per their deal permissions; only admins set targets; workspaces are separate', async () => {
    const { c } = await signup();
    const rita = await inviteUser(c, 'Sales rep', 'Rita');
    const otto = await inviteUser(c, 'Sales rep', 'Otto');
    const mgr = await inviteUser(c, 'Manager', 'Mona');
    await c.put('/targets', { month, targets: [{ userId: rita.id, amount: '1000' }, { userId: otto.id, amount: '1000' }] });
    await wonDeal(c, otto.id, '800');

    // A rep (team scope, no team) sees only themselves; a manager sees everyone.
    const r = (await rita.c.get('/targets')).body;
    expect(r.people.map((p: any) => p.name)).toEqual(['Rita']);
    expect(r).toMatchObject({ canEdit: false, me: { name: 'Rita', target: '1000.00' } });
    expect(r.team.won).toBe('0.00'); // Otto's deal isn't visible to her
    expect((await mgr.c.get('/targets')).body.people.map((p: any) => p.name).sort()).toEqual(['Admin', 'Mona', 'Otto', 'Rita']);

    expect((await rita.c.put('/targets', { month, targets: [{ userId: rita.id, amount: '1' }] })).status).toBe(403);
    expect((await c.put('/targets', { month: '2026-13', targets: [] })).status).toBe(400);
    expect((await c.put('/targets', { month, targets: [{ userId: rita.id, amount: '0' }] })).status).toBe(400);
    expect((await c.get('/targets?month=nope')).status).toBe(400);
    const other = await signup();
    expect((await c.put('/targets', { month, targets: [{ userId: other.me.user.id, amount: '5' }] })).status).toBe(400); // not a member
    expect((await other.c.get('/targets')).body.people.map((p: any) => p.target)).toEqual([null]);
  });
});
