import { afterAll, describe, expect, it } from 'vitest';
import { parseCsv } from '@crm/shared';
import { pool } from '../src/db/pool.ts';
import { getApp, inviteUser, signup, type Client } from './helpers.ts';

afterAll(async () => { await (await getApp()).close(); await pool.end(); });

const csv = async (c: Client, url: string) => {
  const r = await c.raw('GET', url, { headers: {} });
  return { status: r.status, body: r.status === 200 ? parseCsv(String(r.body)) : null };
};

describe('list CSV export', () => {
  it('exports exactly what the list shows (filters, search, sort), with readable custom fields', async () => {
    const { c, me } = await signup();
    const tier = (await c.post('/fields', { entityType: 'contact', label: 'Tier', type: 'select', options: [{ id: 'g', label: 'Gold' }, { id: 's', label: 'Silver' }] })).body;
    await c.post('/fields', { entityType: 'contact', label: 'VIP', type: 'boolean' });
    const acme = (await c.post('/companies', { name: 'Acme' })).body;
    await c.post('/contacts', { firstName: 'Zed', lastName: 'Buyer', primaryCompanyId: acme.id, custom: { [tier.key]: 'g', vip: true }, methods: [{ kind: 'email', value: 'zed@example.com' }] });
    await c.post('/contacts', { firstName: 'Amy', lastName: 'Buyer', custom: { [tier.key]: 's' } });
    await c.post('/contacts', { firstName: 'Other', lastName: 'Person' });

    const all = await csv(c, '/contacts?format=csv&sort=name');
    expect(all.status).toBe(200);
    expect(all.body!.headers).toEqual(['ID', 'First name', 'Last name', 'Job title', 'Company', 'Email', 'Phone', 'Owner', 'Created', 'Updated', 'Tier', 'VIP']);
    expect(all.body!.rows.map((r) => r[1])).toEqual(['Amy', 'Other', 'Zed']);
    const zed = all.body!.rows.find((r) => r[1] === 'Zed')!;
    expect([zed[4], zed[5], zed[7], zed[10], zed[11]]).toEqual(['Acme', 'zed@example.com', me.user.name, 'Gold', 'Yes']);

    const searched = await csv(c, '/contacts?format=csv&q=buyer&sort=-name&page=2&pageSize=1');
    expect(searched.body!.rows.map((r) => r[1])).toEqual(['Zed', 'Amy']); // all matches, not just one page

    const companies = await csv(c, '/companies?format=csv');
    expect(companies.body!.headers.slice(0, 2)).toEqual(['ID', 'Name']);
    expect(companies.body!.rows.map((r) => r[1])).toEqual(['Acme']);

    await c.post('/deals', { title: 'Big order', amount: '1500.50', companyId: acme.id });
    const deals = await csv(c, '/deals?format=csv');
    expect(deals.body!.rows.map((r) => [r[1], r[2], r[4], r[8]])).toEqual([['Big order', 'New', '1500.50', 'Acme']]);
    await c.post('/leads', { title: 'Website form', methods: [{ kind: 'email', value: 'lead@example.com' }] });
    const leads = await csv(c, '/leads?format=csv');
    expect(leads.body!.rows.map((r) => [r[1], r[5], r[7]])).toEqual([['Website form', 'lead@example.com', 'New']]);

    // Each export is in the audit log.
    const log = (await c.get('/audit-log?entityType=export')).body.data;
    expect(log.map((e: any) => [e.changes.entity, e.changes.count])).toEqual([['lead', 1], ['deal', 1], ['company', 1], ['contact', 2], ['contact', 3]]);
    expect(log[3].changes.filters).toMatchObject({ q: 'buyer', sort: '-name' });
  });

  it('neutralises spreadsheet formulas in exported values', async () => {
    const { c } = await signup();
    await c.post('/contacts', { firstName: '=HYPERLINK("http://evil")', lastName: 'X' });
    const r = await c.raw('GET', '/contacts?format=csv', { headers: {} });
    expect(String(r.body)).toContain(`"'=HYPERLINK(""http://evil"")"`);
  });

  it('needs the Export permission and only includes records in the export scope', async () => {
    const { c: admin } = await signup();
    const rep = await inviteUser(admin, 'Sales rep'); // view contacts: all, export: none
    expect((await csv(rep.c, '/contacts?format=csv')).status).toBe(403);
    expect((await rep.c.get('/contacts')).status).toBe(200); // the list itself still works
    await admin.post('/roles', { name: 'Own exporter', grants: { contact: { view: 'all', export: 'own', create: 'all' } } });
    const exp = await inviteUser(admin, 'Own exporter', 'Exa');
    await admin.post('/contacts', { firstName: 'Admin', lastName: 'Owned' });
    await exp.c.post('/contacts', { firstName: 'Exa', lastName: 'Owned' });
    expect((await exp.c.get('/contacts')).body.total).toBe(2); // sees both
    expect((await csv(exp.c, '/contacts?format=csv')).body!.rows.map((r) => r[1])).toEqual(['Exa']); // exports only own
  });

  it('never exports another workspace', async () => {
    const a = await signup('Alpha');
    const b = await signup('Beta');
    await b.c.post('/contacts', { firstName: 'Secret' });
    expect((await csv(a.c, '/contacts?format=csv')).body!.rows).toEqual([]);
  });
});
