import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.ts';
import { getApp, inviteUser, signup } from './helpers.ts';

afterAll(async () => { await (await getApp()).close(); await pool.end(); });

describe('audit log', () => {
  it('lists every change in the workspace, newest first, with who and which record', async () => {
    const { c, me } = await signup('Auditor');
    const rep = await inviteUser(c, 'Sales rep', 'Rita');
    const contact = (await c.post('/contacts', { firstName: 'Ada', lastName: 'Lovelace' })).body;
    await c.patch(`/contacts/${contact.id}`, { jobTitle: 'Engineer' });
    const deal = (await rep.c.post('/deals', { title: 'Rita deal' })).body;
    await c.del(`/contacts/${contact.id}`);

    const r = await c.get('/audit-log');
    expect(r.status).toBe(200);
    const rows = r.body.data;
    expect(rows.slice(0, 4).map((x: any) => [x.action, x.entityType, x.title, x.actorName])).toEqual([
      ['deleted', 'contact', 'Ada Lovelace', me.user.name],
      ['created', 'deal', 'Rita deal', 'Rita'],
      ['updated', 'contact', 'Ada Lovelace', me.user.name],
      ['created', 'contact', 'Ada Lovelace', me.user.name],
    ]);
    expect(rows[0].gone).toBe(true); // in the recycle bin
    expect(rows[1].gone).toBe(false);
    expect(rows[2].changes.job_title).toEqual([null, 'Engineer']);

    // Filters
    expect((await c.get(`/audit-log?actorId=${rep.id}`)).body.data.map((x: any) => x.entityId)).toEqual([deal.id]);
    expect((await c.get('/audit-log?entityType=contact&action=updated')).body.total).toBe(1);
    expect((await c.get('/audit-log?q=rita')).body.data.every((x: any) => x.title === 'Rita deal')).toBe(true);
    const today = new Date().toISOString().slice(0, 10);
    expect((await c.get(`/audit-log?from=${today}&to=${today}`)).body.total).toBe(r.body.total);
    expect((await c.get('/audit-log?from=2000-01-01&to=2000-01-02')).body.total).toBe(0);
    expect((await c.get('/audit-log?pageSize=2&page=2')).body.data.map((x: any) => x.id)).toEqual(rows.slice(2, 4).map((x: any) => x.id));

    const facets = (await c.get('/audit-log/facets')).body;
    expect(facets.actions).toEqual(expect.arrayContaining(['created', 'updated', 'deleted']));
    expect(facets.entityTypes).toEqual(expect.arrayContaining(['contact', 'deal']));
  });

  it('exports the filtered log as CSV', async () => {
    const { c } = await signup();
    await c.post('/companies', { name: 'Globex, "Intl"' });
    const res = await c.raw('GET', '/audit-log?format=csv&entityType=company', { headers: { 'x-requested-with': 'crm' } });
    expect(res.status).toBe(200);
    const lines = String(res.body).trim() /* trim() also drops the BOM */.split('\r\n');
    expect(lines[0]).toBe('When (UTC),Who,Action,Record type,Record id,Record,Changes');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('"Globex, ""Intl"""');
  });

  it('is for admins only and never shows another workspace', async () => {
    const a = await signup('Alpha');
    const b = await signup('Beta');
    await b.c.post('/contacts', { firstName: 'Secret' });
    const manager = await inviteUser(a.c, 'Manager');
    expect((await manager.c.get('/audit-log')).status).toBe(403);
    expect((await manager.c.get('/audit-log/facets')).status).toBe(403);
    expect((await manager.c.raw('GET', '/audit-log?format=csv', { headers: {} })).status).toBe(403);
    const mine = (await a.c.get('/audit-log?pageSize=100')).body.data;
    expect(mine.some((x: any) => x.title === 'Secret')).toBe(false);
    expect((await a.c.get('/audit-log?q=Secret')).body.total).toBe(0);
  });
});
