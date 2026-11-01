 
import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.ts';
import { getApp, inviteUser, signup } from './helpers.ts';

afterAll(async () => { await (await getApp()).close(); await pool.end(); });

describe('role-based access', () => {
  it('sales reps see team records, edit only their own, and cannot touch settings', async () => {
    const { c: admin, meta } = await signup();
    const rep1 = await inviteUser(admin, 'Sales rep', 'Rep One');
    const rep2 = await inviteUser(admin, 'Sales rep', 'Rep Two');
    const outsider = await inviteUser(admin, 'Sales rep', 'Outsider');
    expect((await admin.post('/teams', { name: 'East', memberIds: [rep1.id, rep2.id] })).status).toBe(201);
    expect((await admin.get('/meta')).body.teams[0].memberIds.sort()).toEqual([rep1.id, rep2.id].sort());
    // Teams are loaded at sign-in time per request, so new membership applies immediately.
    const d1 = (await rep1.c.post('/deals', { title: 'Rep1 deal' })).body;
    const d2 = (await rep2.c.post('/deals', { title: 'Rep2 deal' })).body;
    const dOut = (await outsider.c.post('/deals', { title: 'Outsider deal' })).body;

    const seen = (await rep1.c.get('/deals')).body.data.map((d: any) => d.title).sort();
    expect(seen).toEqual(['Rep1 deal', 'Rep2 deal']);
    expect((await rep1.c.get(`/deals/${dOut.id}`)).status).toBe(403);
    expect((await rep1.c.get(`/deals/${d2.id}`)).status).toBe(200);
    expect((await rep1.c.patch(`/deals/${d2.id}`, { title: 'Hijack' })).status).toBe(403);
    expect((await rep1.c.patch(`/deals/${d1.id}`, { title: 'Mine' })).status).toBe(200);
    expect((await rep1.c.del(`/deals/${d2.id}`)).status).toBe(403);
    expect((await rep1.c.post(`/deals/${d2.id}/move`, { stageId: meta.pipelines.find((p: any) => p.entityType === 'deal').stages[1].id })).status).toBe(403);
    // Admin sees everything.
    expect((await admin.get('/deals')).body.total).toBe(3);
    // Settings are admin-only.
    expect((await rep1.c.post('/fields', { entityType: 'deal', label: 'X', type: 'text' })).status).toBe(403);
    expect((await rep1.c.post('/users/invite', { email: 'x@example.com', name: 'X', roleId: 1 })).status).toBe(403);
    // Reports are scoped too.
    const report = (await rep1.c.get('/reports/deals-by-owner')).body.rows.map((r: any) => r.owner).sort();
    expect(report).toEqual(['Rep One', 'Rep Two']);
  });

  it('private records are hidden from people with "all" scope; viewers are read-only', async () => {
    const { c: admin } = await signup();
    const manager = await inviteUser(admin, 'Manager', 'Mona');
    const viewer = await inviteUser(admin, 'Viewer', 'Vic');
    const priv = (await admin.post('/contacts', { firstName: 'Secret', visibility: 'private' })).body;
    await admin.post('/contacts', { firstName: 'Public' });
    const names = (await manager.c.get('/contacts')).body.data.map((x: any) => x.firstName);
    expect(names).toEqual(['Public']);
    expect((await manager.c.get(`/contacts/${priv.id}`)).status).toBe(403);
    expect((await viewer.c.get('/contacts')).body.total).toBe(1);
    expect((await viewer.c.post('/contacts', { firstName: 'Nope' })).status).toBe(403);
    expect((await viewer.c.get('/reports/won-deals?format=csv')).status).toBe(403);
  });

  it('custom roles can be created and edited', async () => {
    const { c: admin } = await signup();
    const r = await admin.post('/roles', { name: 'Support', grants: { contact: { view: 'all', edit: 'all' }, company: { view: 'all' } } });
    expect(r.status).toBe(201);
    const roles = (await admin.get('/roles')).body.data;
    expect(roles.find((x: any) => x.id === r.body.id).grants.contact).toEqual({ view: 'all', edit: 'all' });
    const sup = await inviteUser(admin, 'Support', 'Sue');
    expect((await sup.c.get('/deals')).status).toBe(403);
    expect((await sup.c.get('/contacts')).status).toBe(200);
    const adminRole = roles.find((x: any) => x.isAdmin);
    expect((await admin.patch(`/roles/${adminRole.id}`, { grants: {} })).status).toBe(400);
    expect((await admin.del(`/roles/${r.body.id}`)).status).toBe(400); // has a member
  });

  it('isolates workspaces completely', async () => {
    const a = await signup('A');
    const b = await signup('B');
    const ct = (await a.c.post('/contacts', { firstName: 'Tenant', lastName: 'A' })).body;
    const deal = (await a.c.post('/deals', { title: 'Tenant A deal' })).body;
    expect((await b.c.get(`/contacts/${ct.id}`)).status).toBe(404);
    expect((await b.c.patch(`/deals/${deal.id}`, { title: 'x' })).status).toBe(404);
    expect((await b.c.del(`/contacts/${ct.id}`)).status).toBe(404);
    expect((await b.c.get('/contacts')).body.total).toBe(0);
    expect((await b.c.get('/search?q=tenant')).body.data).toHaveLength(0);
    // Cannot reference another tenant's records or stages.
    expect((await b.c.post('/deals', { title: 'x', contactIds: [ct.id] })).status).toBe(400);
    expect((await b.c.post('/deals', { title: 'x', stageId: a.dealPipeline.stages[0].id })).status).toBe(404);
    expect((await b.c.post('/notes', { entityType: 'contact', entityId: ct.id, body: 'hi' })).status).toBe(404);
  });
});
