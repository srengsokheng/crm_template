import { afterAll, describe, expect, it } from 'vitest';
import { q, sql } from '../src/db/index.ts';
import { pool } from '../src/db/pool.ts';
import { getApp, inviteUser, signup, type Client } from './helpers.ts';

afterAll(async () => { await (await getApp()).close(); await pool.end(); });

/** Everything a contact "owns", in a comparable shape. */
async function stateOf(c: Client, id: number) {
  const r = (await c.get(`/contacts/${id}`)).body;
  const methods = await q<{ id: number; kind: string; value: string; is_primary: boolean }>(sql`SELECT id, kind, value, is_primary FROM contact_methods WHERE party_type = 'contact' AND party_id = ${id} ORDER BY id`);
  const deals = await q<{ deal_id: number; is_primary: boolean }>(sql`SELECT deal_id, is_primary FROM deal_contacts WHERE contact_id = ${id} ORDER BY deal_id`);
  const companies = await q<{ company_id: number }>(sql`SELECT company_id FROM contact_companies WHERE contact_id = ${id} ORDER BY company_id`);
  const notes = await q<{ id: number }>(sql`SELECT id FROM notes WHERE entity_type = 'contact' AND entity_id = ${id} ORDER BY id`);
  const files = await q<{ id: number }>(sql`SELECT id FROM attachments WHERE entity_type = 'contact' AND entity_id = ${id} ORDER BY id`);
  const acts = await q<{ activity_id: number }>(sql`SELECT activity_id FROM activity_links WHERE entity_type = 'contact' AND entity_id = ${id} ORDER BY activity_id`);
  const audit = await q<{ id: number }>(sql`SELECT id FROM audit_events WHERE entity_type = 'contact' AND entity_id = ${id} AND action NOT IN ('merged','merged_into','merge_undone') ORDER BY id`);
  return {
    fields: { firstName: r.firstName, lastName: r.lastName, jobTitle: r.jobTitle, birthday: r.birthday, primaryCompanyId: r.primaryCompanyId, custom: r.custom, ownerId: r.ownerId },
    methods, deals, companies, notes, files, acts, audit,
  };
}

describe('undo a merge', () => {
  it('restores both contacts exactly; things added after the merge stay; can only be undone once', async () => {
    const { c } = await signup();
    const tier = (await c.post('/fields', { entityType: 'contact', label: 'Tier', type: 'text' })).body.key;
    const acme = (await c.post('/companies', { name: 'Acme' })).body;
    const globex = (await c.post('/companies', { name: 'Globex' })).body;
    const a = (await c.post('/contacts', { firstName: 'Ada', lastName: 'Lovelace', primaryCompanyId: acme.id, methods: [{ kind: 'email', value: 'ada@example.com' }], custom: { [tier]: 'Gold' } })).body;
    const b = (await c.post('/contacts', { firstName: 'Ada', lastName: 'L.', jobTitle: 'Countess', birthday: '1815-12-10', primaryCompanyId: globex.id,
      methods: [{ kind: 'email', value: 'ada@example.com' }, { kind: 'phone', value: '+44 20 7946 0001' }], custom: { [tier]: 'Silver' } })).body;
    const shared = (await c.post('/deals', { title: 'Shared deal', contactIds: [a.id, b.id] })).body;
    const onlyB = (await c.post('/deals', { title: 'B deal', contactIds: [b.id] })).body;
    await c.post('/notes', { entityType: 'contact', entityId: b.id, body: 'Note on B' });
    await c.upload(`/attachments?entityType=contact&entityId=${b.id}&fileName=b.pdf`, Buffer.from('%PDF'));
    await c.post('/activities', { kind: 'call', subject: 'Call B', links: [{ entityType: 'contact', entityId: b.id }] });
    const beforeA = await stateOf(c, a.id);
    const beforeB = await stateOf(c, b.id);

    const m = (await c.post('/merge/contact', { survivorId: a.id, mergedId: b.id, choose: { jobTitle: 'merged', [`custom.${tier}`]: 'merged' } })).body;
    expect(m.undoId).toBeTruthy();
    const merged = await stateOf(c, a.id);
    expect(merged.fields).toMatchObject({ jobTitle: 'Countess', custom: { [tier]: 'Silver' } });
    expect(merged.deals.map((d) => Number(d.deal_id)).sort()).toEqual([shared.id, onlyB.id].sort());
    expect((await c.get(`/merge/contact/undoable/${a.id}`)).body).toMatchObject({ undoId: m.undoId, merged: [{ id: b.id, title: 'Ada L.' }] });

    // Something new on the kept contact after the merge (doesn't edit the contact itself).
    const later = (await c.post('/notes', { entityType: 'contact', entityId: a.id, body: 'Added after the merge' })).body;

    const u = await c.post(`/merge/contact/undo/${m.undoId}`, {});
    expect(u.status, JSON.stringify(u.body)).toBe(200);
    expect(u.body).toEqual({ id: a.id, restoredIds: [b.id] });
    const afterA = await stateOf(c, a.id);
    const afterB = await stateOf(c, b.id);
    expect(afterB).toEqual(beforeB); // fields, contact details (same ids), deals, companies, notes, files, activities, history
    expect({ ...afterA, notes: afterA.notes.filter((n) => Number(n.id) !== later.id) }).toEqual(beforeA);
    expect(afterA.notes.map((n) => Number(n.id))).toContain(later.id); // stays on the kept contact
    expect((await c.get(`/contacts/${b.id}`)).status).toBe(200); // live again, no "merged" redirect
    const hist = (await c.get(`/history/contact/${a.id}`)).body.data.map((h: any) => h.action);
    expect(hist).toContain('merge_undone');

    expect((await c.post(`/merge/contact/undo/${m.undoId}`, {})).status).toBe(409); // only once
    expect((await c.get(`/merge/contact/undoable/${a.id}`)).body).toBeNull();
  });

  it('three-way company merge undone; edited survivor blocks undo; permissions and isolation', async () => {
    const { c } = await signup();
    const x = (await c.post('/companies', { name: 'Initech' })).body;
    const y = (await c.post('/companies', { name: 'Initech Ltd', methods: [{ kind: 'website', value: 'https://initech.example' }] })).body;
    const z = (await c.post('/companies', { name: 'INITECH' })).body;
    const dy = (await c.post('/deals', { title: 'Y deal', companyId: y.id })).body;
    const person = (await c.post('/contacts', { firstName: 'Peter', primaryCompanyId: z.id })).body;
    const m = (await c.post('/merge/company', { survivorId: x.id, mergedIds: [y.id, z.id] })).body;
    expect((await c.get(`/deals/${dy.id}`)).body.companyId).toBe(x.id);
    expect((await c.get(`/contacts/${person.id}`)).body.primaryCompanyId).toBe(x.id);

    // Other workspace / viewer can't undo.
    const other = await signup('Other');
    expect((await other.c.post(`/merge/company/undo/${m.undoId}`, {})).status).toBe(404);
    const viewer = await inviteUser(c, 'Viewer');
    expect((await viewer.c.post(`/merge/company/undo/${m.undoId}`, {})).status).toBe(403);

    expect((await c.post(`/merge/company/undo/${m.undoId}`, {})).status).toBe(200);
    expect((await c.get(`/deals/${dy.id}`)).body.companyId).toBe(y.id);
    expect((await c.get(`/contacts/${person.id}`)).body.primaryCompanyId).toBe(z.id);
    expect((await c.get(`/companies/${y.id}`)).body.methods.map((mm: any) => mm.value)).toEqual(['https://initech.example']);
    expect((await c.get(`/companies/${z.id}`)).status).toBe(200);

    // Merge again, then edit the kept company: undo is no longer possible.
    const m2 = (await c.post('/merge/company', { survivorId: x.id, mergedId: y.id })).body;
    await c.patch(`/companies/${x.id}`, { description: 'Edited after the merge' });
    expect((await c.get(`/merge/company/undoable/${x.id}`)).body).toBeNull();
    const refused = await c.post(`/merge/company/undo/${m2.undoId}`, {});
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toBe('“Initech” was changed after the merge, so the merge can’t be undone automatically');
    // Too old: 8 days.
    const m3 = (await c.post('/merge/company', { survivorId: x.id, mergedId: z.id })).body;
    await q(sql`UPDATE merge_snapshots SET created_at = now() - interval '8 days' WHERE id = ${m3.undoId}`);
    await q(sql`UPDATE companies SET updated_at = now() - interval '9 days' WHERE id = ${x.id}`);
    expect((await c.post(`/merge/company/undo/${m3.undoId}`, {})).body.error.message).toBe('Merges can be undone for 7 days');
  });

  it('leads: product lists are combined without duplicates, and undo puts them back', async () => {
    const { c } = await signup();
    const p = (await c.post('/products', { name: 'Picker', unitPrice: '1000' })).body;
    const a = (await c.post('/leads', { title: 'Lead A', firstName: 'Kim' })).body;
    const b = (await c.post('/leads', { title: 'Lead B', firstName: 'Kim' })).body;
    await c.put(`/leads/${a.id}/line-items`, { items: [{ productId: p.id, name: 'Picker', unitPrice: '1000', quantity: 1, unit: 'pcs' }] });
    await c.put(`/leads/${b.id}/line-items`, { items: [
      { productId: p.id, name: 'Picker', unitPrice: '1000', quantity: 2, unit: 'pcs' }, // same product → not added again
      { name: 'Installation', unitPrice: '300', quantity: 1, unit: 'pcs' },
    ] });
    const m = (await c.post('/merge/lead', { survivorId: a.id, mergedId: b.id })).body;
    const kept = (await c.get(`/leads/${a.id}`)).body.lineItems.map((l: any) => [l.name, l.quantity]);
    expect(kept).toEqual([['Picker', '1.000'], ['Installation', '1.000']]);
    expect((await c.post(`/merge/lead/undo/${m.undoId}`, {})).status).toBe(200);
    expect((await c.get(`/leads/${a.id}`)).body.lineItems.map((l: any) => l.name)).toEqual(['Picker']);
    expect((await c.get(`/leads/${b.id}`)).body.lineItems.map((l: any) => [l.name, l.quantity])).toEqual([['Picker', '2.000'], ['Installation', '1.000']]);
  });
});
