import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.ts';
import { client, getApp, inviteUser, signup } from './helpers.ts';

afterAll(async () => { await (await getApp()).close(); await pool.end(); });

describe('your account', () => {
  it('changes your name', async () => {
    const { c } = await signup('Ada');
    expect((await c.patch('/auth/profile', { name: '  Ada Lovelace ' })).body).toEqual({ name: 'Ada Lovelace' });
    expect((await c.get('/auth/me')).body.user.name).toBe('Ada Lovelace');
    expect((await c.patch('/auth/profile', { name: '' })).status).toBe(400);
  });

  it('changes your password: needs the current one, signs out your other sessions, keeps this one', async () => {
    const { c, email } = await signup();
    const app = await getApp();
    const other = client(app);
    expect((await other.post('/auth/login', { email, password: 'password123' })).status).toBe(200);
    expect((await other.get('/auth/me')).status).toBe(200);

    const wrong = await c.post('/auth/password', { currentPassword: 'nope', newPassword: 'brand-new-pass' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.fields).toEqual({ currentPassword: 'Not correct' });
    expect((await c.post('/auth/password', { currentPassword: 'password123', newPassword: 'short' })).status).toBe(400);
    const same = await c.post('/auth/password', { currentPassword: 'password123', newPassword: 'password123' });
    expect(same.body.error.fields).toEqual({ newPassword: 'Same as your current password' });

    const ok = await c.post('/auth/password', { currentPassword: 'password123', newPassword: 'brand-new-pass' });
    expect(ok.status).toBe(200);
    expect(ok.body.signedOutSessions).toBe(1);
    expect((await c.get('/auth/me')).status).toBe(200); // this session stays
    expect((await other.get('/auth/me')).status).toBe(401); // the other one is gone
    const fresh = client(app);
    expect((await fresh.post('/auth/login', { email, password: 'password123' })).status).toBe(401);
    expect((await fresh.post('/auth/login', { email, password: 'brand-new-pass' })).status).toBe(200);
    // Signed out: no password change.
    const anon = client(app);
    expect((await anon.post('/auth/password', { currentPassword: 'x', newPassword: 'yyyyyyyy' })).status).toBe(401);
  });
});

describe('automation history on a record', () => {
  it('is visible only to people who may see that record', async () => {
    const { c, meta } = await signup();
    const rep = await inviteUser(c, 'Sales rep', 'Rita');
    const pipe = meta.pipelines.find((p: any) => p.entityType === 'deal');
    expect((await c.post('/automation-rules', { entityType: 'deal', pipelineId: pipe.id, trigger: 'created', action: 'add_note', config: { text: 'Welcome note' } })).status).toBe(201);
    const mine = (await c.post('/deals', { title: 'Admin private deal', visibility: 'private' })).body;
    const shared = (await c.post('/deals', { title: 'Shared deal', ownerId: rep.id })).body;
    await pool.query(`INSERT INTO automation_runs (workspace_id, entity_type, entity_id, status, message) VALUES
      ((SELECT workspace_id FROM deals WHERE id = $1), 'deal', $1, 'failed', 'Secret failure details'),
      ((SELECT workspace_id FROM deals WHERE id = $2), 'deal', $2, 'success', NULL)`, [mine.id, shared.id]);
    // The admin sees runs on both; the rep only on the deal they may see.
    expect((await c.get(`/automation-runs/deal/${mine.id}`)).body.data.map((r: any) => r.status)).toContain('failed');
    expect((await rep.c.get(`/automation-runs/deal/${shared.id}`)).status).toBe(200);
    expect((await rep.c.get(`/automation-runs/deal/${mine.id}`)).status).toBe(403); // used to return the runs (same rule as the record's timeline)
    const other = await signup();
    expect((await other.c.get(`/automation-runs/deal/${shared.id}`)).status).toBe(404);
    // Paged like the other feeds.
    for (let i = 0; i < 25; i++) await pool.query(`INSERT INTO automation_runs (workspace_id, entity_type, entity_id, status) SELECT workspace_id, 'deal', id, 'skipped' FROM deals WHERE id = $1`, [shared.id]);
    const p1 = (await c.get(`/automation-runs/deal/${shared.id}`)).body;
    expect(p1.data).toHaveLength(20);
    const p2 = (await c.get(`/automation-runs/deal/${shared.id}?before=${p1.nextCursor}`)).body;
    const total = (await pool.query(`SELECT count(*)::int AS n FROM automation_runs WHERE entity_type = 'deal' AND entity_id = $1`, [shared.id])).rows[0].n;
    expect(total).toBeGreaterThan(20);
    const ids = [...p1.data, ...p2.data].map((r: any) => r.id);
    expect(ids).toHaveLength(total);
    expect(new Set(ids).size).toBe(total);
    expect(p2.nextCursor).toBeNull();
  });
});

describe('product categories and custom-field order', () => {
  it('admins manage categories; deleting one keeps its products', async () => {
    const { c } = await signup();
    const rep = await inviteUser(c, 'Sales rep');
    const cat = (await c.post('/product-categories', { name: 'Robots' })).body;
    expect((await rep.c.post('/product-categories', { name: 'Nope' })).status).toBe(403);
    const p = (await c.post('/products', { name: 'Arm', unitPrice: '100', categoryId: cat.id })).body;
    expect((await c.patch(`/product-categories/${cat.id}`, { name: 'Robot arms' })).body.name).toBe('Robot arms');
    expect((await c.get('/meta')).body.productCategories.map((x: any) => x.name)).toEqual(['Robot arms']);
    expect((await c.del(`/product-categories/${cat.id}`)).status).toBe(204);
    const after = (await c.get(`/products/${p.id}`)).body;
    expect(after.name).toBe('Arm');
    expect(after.categoryId).toBeNull();
  });

  it('reorders custom fields (admins only); records and forms follow the order', async () => {
    const { c } = await signup();
    const rep = await inviteUser(c, 'Sales rep');
    const a = (await c.post('/fields', { entityType: 'deal', label: 'Alpha', type: 'text' })).body;
    const b = (await c.post('/fields', { entityType: 'deal', label: 'Beta', type: 'text' })).body;
    const g = (await c.post('/fields', { entityType: 'deal', label: 'Gamma', type: 'text' })).body;
    expect((await c.post('/fields/reorder', { ids: [g.id, a.id, b.id] })).status).toBe(200);
    const order = (await c.get('/meta')).body.fields.filter((f: any) => f.entityType === 'deal').map((f: any) => f.label);
    expect(order).toEqual(['Gamma', 'Alpha', 'Beta']);
    expect((await rep.c.post('/fields/reorder', { ids: [a.id, b.id, g.id] })).status).toBe(403);
  });
});

describe('history names related records, only when you may see them', () => {
  it('shows a related deal\'s title to people who can see it, and a neutral line to others', async () => {
    const { c } = await signup();
    const rep = await inviteUser(c, 'Sales rep', 'Rita');
    const contact = (await c.post('/contacts', { firstName: 'Ada' })).body;
    await c.post('/deals', { title: 'Open deal', contactIds: [contact.id], ownerId: rep.id }); // the rep's own deal
    await c.post('/deals', { title: 'Secret deal', contactIds: [contact.id], visibility: 'private' });
    const titles = (r: any) => r.body.items.filter((i: any) => i.type === 'event' && i.data.entityType === 'deal').map((i: any) => i.data.entityTitle);
    expect(titles(await c.get(`/timeline/contact/${contact.id}`)).sort()).toEqual(['Open deal', 'Secret deal']);
    const seen = titles(await rep.c.get(`/timeline/contact/${contact.id}`));
    expect(seen).toContain('Open deal');
    expect(seen).not.toContain('Secret deal'); // its event may show, without the title
  });

  it('saves and clears addresses on companies, contacts and leads', async () => {
    const { c } = await signup();
    const co = (await c.post('/companies', { name: 'Globex' })).body;
    const addr = { street: '12 Riverside', city: 'Phnom Penh', region: null, postalCode: '12000', country: 'Cambodia' };
    expect((await c.patch(`/companies/${co.id}`, { address: addr })).status).toBe(200);
    expect((await c.get(`/companies/${co.id}`)).body.address).toMatchObject({ street: '12 Riverside', city: 'Phnom Penh', country: 'Cambodia' });
    expect((await c.patch(`/companies/${co.id}`, { address: null })).status).toBe(200);
    expect((await c.get(`/companies/${co.id}`)).body.address).toBeNull();
    const ct = (await c.post('/contacts', { firstName: 'Ada', address: addr })).body;
    expect((await c.get(`/contacts/${ct.id}`)).body.address.city).toBe('Phnom Penh');
    const ld = (await c.post('/leads', { title: 'L', address: addr })).body;
    expect((await c.get(`/leads/${ld.id}`)).body.address.postalCode).toBe('12000');
  });
});
