import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.ts';
import { getApp, inviteUser, signup } from './helpers.ts';

afterAll(async () => { await (await getApp()).close(); await pool.end(); });

describe('saved views', () => {
  it('saves personal views per list, never storing the page number', async () => {
    const { c } = await signup();
    const r = await c.post('/views', { entityType: 'deal', name: 'My open deals', query: { ownerId: 'me', status: 'open', page: '3', view: 'list' } });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ name: 'My open deals', shared: false, query: { ownerId: 'me', status: 'open', view: 'list' } });
    expect(r.body.query.page).toBeUndefined();
    await c.post('/views', { entityType: 'contact', name: 'Customers', query: { typeId: '5' } });
    expect((await c.get('/views?entityType=deal')).body.data.map((v: any) => v.name)).toEqual(['My open deals']);
    const ren = await c.patch(`/views/${r.body.id}`, { name: 'Open deals (mine)', query: { ownerId: 'me' } });
    expect(ren.body).toMatchObject({ name: 'Open deals (mine)', query: { ownerId: 'me' } });
    expect((await c.del(`/views/${r.body.id}`)).status).toBe(204);
    expect((await c.get('/views?entityType=deal')).body.data).toEqual([]);
  });

  it('validates input', async () => {
    const { c } = await signup();
    expect((await c.post('/views', { entityType: 'product', name: 'X', query: {} })).status).toBe(400);
    expect((await c.post('/views', { entityType: 'deal', name: '  ', query: {} })).status).toBe(400);
    expect((await c.post('/views', { entityType: 'deal', name: 'X', query: { 'bad key!': '1' } })).status).toBe(400);
    expect((await c.post('/views', { entityType: 'deal', name: 'X', query: { q: 'x'.repeat(201) } })).status).toBe(400);
    expect((await c.get('/views?entityType=nope')).status).toBe(400);
  });

  it('keeps personal views private; shared views are visible to all and managed by admins', async () => {
    const { c: admin } = await signup();
    const rep = await inviteUser(admin, 'Sales rep', 'Rita');
    const other = await inviteUser(admin, 'Sales rep', 'Otto');
    const mine = (await rep.c.post('/views', { entityType: 'lead', name: 'Rita hot leads', query: { q: 'hot' } })).body;
    expect((await other.c.get('/views?entityType=lead')).body.data).toEqual([]);
    expect((await other.c.patch(`/views/${mine.id}`, { name: 'Hijacked' })).status).toBe(404);
    expect((await other.c.del(`/views/${mine.id}`)).status).toBe(404);
    expect((await admin.get('/views?entityType=lead')).body.data).toEqual([]); // personal even for admins

    expect((await rep.c.post('/views', { entityType: 'lead', name: 'Team', query: {}, shared: true })).status).toBe(403);
    expect((await rep.c.patch(`/views/${mine.id}`, { shared: true })).status).toBe(403);
    const shared = (await admin.post('/views', { entityType: 'lead', name: 'New this week', query: { createdFrom: '2026-11-09' }, shared: true })).body;
    expect(shared.shared).toBe(true);
    const seen = (await other.c.get('/views?entityType=lead')).body;
    expect(seen).toMatchObject({ canShare: false, data: [{ name: 'New this week', shared: true }] });
    expect((await other.c.patch(`/views/${shared.id}`, { name: 'Mine now' })).status).toBe(403);
    expect((await other.c.del(`/views/${shared.id}`)).status).toBe(403);
    // Rita sees the shared view first, then her own.
    expect((await rep.c.get('/views?entityType=lead')).body.data.map((v: any) => v.name)).toEqual(['New this week', 'Rita hot leads']);
    expect((await admin.del(`/views/${shared.id}`)).status).toBe(204);
  });

  it('never crosses workspaces', async () => {
    const a = await signup('Alpha');
    const b = await signup('Beta');
    const v = (await a.c.post('/views', { entityType: 'deal', name: 'Alpha shared', query: {}, shared: true })).body;
    expect((await b.c.get('/views?entityType=deal')).body.data).toEqual([]);
    expect((await b.c.patch(`/views/${v.id}`, { name: 'x' })).status).toBe(404);
    expect((await b.c.del(`/views/${v.id}`)).status).toBe(404);
  });
});
