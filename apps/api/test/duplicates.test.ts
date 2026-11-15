import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.ts';
import { getApp, inviteUser, signup } from './helpers.ts';

afterAll(async () => { await (await getApp()).close(); await pool.end(); });

describe('find duplicates', () => {
  it('pairs contacts sharing email, phone or name; strongest first; skips deleted and unrelated', async () => {
    const { c } = await signup();
    const ada1 = (await c.post('/contacts', { firstName: 'Ada', lastName: 'Lovelace', methods: [{ kind: 'email', value: 'ada@example.com' }, { kind: 'phone', value: '+44 20 7946 0001' }] })).body;
    const ada2 = (await c.post('/contacts', { firstName: 'ada', lastName: 'lovelace ', methods: [{ kind: 'email', value: 'ADA@example.com' }, { kind: 'phone', value: '+44 (20) 7946-0001' }] })).body;
    const bob1 = (await c.post('/contacts', { firstName: 'Bob', lastName: 'One', methods: [{ kind: 'email', value: 'shared@example.com' }] })).body;
    const bob2 = (await c.post('/contacts', { firstName: 'Robert', lastName: 'Two', methods: [{ kind: 'email', value: 'shared@example.com' }] })).body;
    await c.post('/contacts', { firstName: 'Unique', lastName: 'Person', methods: [{ kind: 'email', value: 'unique@example.com' }] });
    const gone = (await c.post('/contacts', { firstName: 'Bob', lastName: 'One' })).body;
    await c.del(`/contacts/${gone.id}`);

    const r = (await c.get('/duplicates/pairs?entityType=contact')).body;
    expect(r.more).toBe(false);
    expect(r.data.map((p: any) => [p.a, p.b, p.reasons.map((x: any) => x.kind)])).toEqual([
      [ada1.id, ada2.id, ['email', 'name', 'phone']],
      [bob1.id, bob2.id, ['email']],
    ]);
    expect(r.data[0].left).toMatchObject({ id: ada1.id, title: 'Ada Lovelace' });
    expect(r.data[0].right).toMatchObject({ id: ada2.id, title: 'ada lovelace' });
    expect(r.data[1].reasons[0].value).toBe('shared@example.com');
  });

  it('pairs companies by website, and hides pairs marked "not a duplicate"', async () => {
    const { c } = await signup();
    const a = (await c.post('/companies', { name: 'Initech Logistics', methods: [{ kind: 'website', value: 'https://www.initech.example.com/' }] })).body;
    const b = (await c.post('/companies', { name: 'Initech', methods: [{ kind: 'website', value: 'initech.example.com' }] })).body;
    expect((await c.get('/duplicates/pairs?entityType=company')).body.data.map((p: any) => [p.a, p.b, p.reasons[0].kind])).toEqual([[a.id, b.id, 'website']]);
    expect((await c.post('/duplicates/dismiss', { entityType: 'company', ids: [b.id, a.id] })).status).toBe(204);
    expect((await c.post('/duplicates/dismiss', { entityType: 'company', ids: [a.id, b.id] })).status).toBe(204); // idempotent
    expect((await c.get('/duplicates/pairs?entityType=company')).body.data).toEqual([]);
    const hist = (await c.get(`/history/company/${a.id}`)).body.data;
    expect(hist.some((h: any) => h.action === 'not_duplicate' && h.changes.other.id === b.id)).toBe(true);
    // Merging removes the pair too.
    const x = (await c.post('/companies', { name: 'Globex' })).body;
    const y = (await c.post('/companies', { name: 'GLOBEX' })).body;
    expect((await c.get('/duplicates/pairs?entityType=company')).body.data).toHaveLength(1);
    await c.post('/merge/company', { survivorId: x.id, mergedId: y.id });
    expect((await c.get('/duplicates/pairs?entityType=company')).body.data).toEqual([]);
  });

  it('only looks at records the caller can see, and needs edit rights to dismiss', async () => {
    const { c: admin } = await signup();
    await admin.post('/roles', { name: 'Own only', grants: { contact: { view: 'own', edit: 'own', create: 'all' } } });
    const rep = await inviteUser(admin, 'Own only', 'Rita');
    const viewer = await inviteUser(admin, 'Viewer', 'Vic');
    await admin.post('/contacts', { firstName: 'Admin', lastName: 'Twin', methods: [{ kind: 'email', value: 'twin@example.com' }] });
    await admin.post('/contacts', { firstName: 'Admin', lastName: 'Twin', methods: [{ kind: 'email', value: 'twin@example.com' }] });
    const r1 = (await rep.c.post('/contacts', { firstName: 'Rita', lastName: 'Twin' })).body;
    const r2 = (await rep.c.post('/contacts', { firstName: 'Rita', lastName: 'Twin' })).body;
    expect((await rep.c.get('/duplicates/pairs?entityType=contact')).body.data.map((p: any) => [p.a, p.b])).toEqual([[r1.id, r2.id]]);
    expect((await admin.get('/duplicates/pairs?entityType=contact')).body.data).toHaveLength(2);
    const adminPair = (await admin.get('/duplicates/pairs?entityType=contact')).body.data.find((p: any) => p.a !== r1.id);
    expect((await rep.c.post('/duplicates/dismiss', { entityType: 'contact', ids: [adminPair.a, adminPair.b] })).status).toBe(403);
    expect((await viewer.c.post('/duplicates/dismiss', { entityType: 'contact', ids: [r1.id, r2.id] })).status).toBe(403);
    expect((await admin.get('/duplicates/pairs?entityType=deal')).status).toBe(400);
  });

  it('never crosses workspaces', async () => {
    const a = await signup('Alpha');
    const b = await signup('Beta');
    const x = (await a.c.post('/contacts', { firstName: 'Same', lastName: 'Name' })).body;
    const y = (await b.c.post('/contacts', { firstName: 'Same', lastName: 'Name' })).body;
    expect((await a.c.get('/duplicates/pairs?entityType=contact')).body.data).toEqual([]);
    expect((await a.c.post('/duplicates/dismiss', { entityType: 'contact', ids: [x.id, y.id] })).status).toBe(400);
  });
});
