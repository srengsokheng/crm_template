import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.ts';
import { getApp, inviteUser, signup } from './helpers.ts';

afterAll(async () => { await (await getApp()).close(); await pool.end(); });

describe('deals on contact and company pages', () => {
  it('only deals the user may see (deal view scope), with the total', async () => {
    const { c } = await signup();
    const { c: rep } = await inviteUser(c, 'Sales rep');
    const company = (await c.post('/companies', { name: 'Umbrella' })).body;
    const contact = (await c.post('/contacts', { firstName: 'Dara', primaryCompanyId: company.id })).body;
    await c.post('/deals', { title: 'Admin deal', companyId: company.id, contactIds: [contact.id] });
    await rep.post('/deals', { title: 'Rep deal', companyId: company.id, contactIds: [contact.id] });
    const seen = async (cl: any, path: string) => { const b = (await cl.get(path)).body; return { titles: b.deals.map((d: any) => d.title).sort(), total: b.dealsTotal }; };
    expect(await seen(c, `/contacts/${contact.id}`)).toEqual({ titles: ['Admin deal', 'Rep deal'], total: 2 });
    expect(await seen(c, `/companies/${company.id}`)).toEqual({ titles: ['Admin deal', 'Rep deal'], total: 2 });
    // The rep's role sees team deals; the admin isn't on their team.
    const list = (await rep.get(`/deals?contactId=${contact.id}`)).body;
    expect(await seen(rep, `/contacts/${contact.id}`)).toEqual({ titles: list.data.map((d: any) => d.title).sort(), total: list.total });
    expect(await seen(rep, `/companies/${company.id}`)).toEqual({ titles: list.data.map((d: any) => d.title).sort(), total: list.total });
    expect(list.data.map((d: any) => d.title)).toEqual(['Rep deal']);
  });

  it('the first 10 inline; the deals list pages the rest by contact or company', async () => {
    const { c } = await signup();
    const company = (await c.post('/companies', { name: 'Busy Co' })).body;
    for (let i = 0; i < 13; i++) await c.post('/deals', { title: `D${i}`, companyId: company.id });
    const detail = (await c.get(`/companies/${company.id}`)).body;
    expect(detail.deals).toHaveLength(10);
    expect(detail.dealsTotal).toBe(13);
    const p2 = (await c.get(`/deals?companyId=${company.id}&pageSize=10&page=2`)).body;
    expect(p2.total).toBe(13);
    expect(p2.data).toHaveLength(3);
  });
});
