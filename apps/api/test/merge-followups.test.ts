import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.ts';
import { getApp, signup } from './helpers.ts';

afterAll(async () => { await (await getApp()).close(); await pool.end(); });

describe('merge follow-ups', () => {
  it('merges three contacts at once: values per field from any record, everything moves, all retired', async () => {
    const { c } = await signup();
    const a = (await c.post('/contacts', { firstName: 'Ada', lastName: 'Lovelace', methods: [{ kind: 'email', value: 'ada@example.com' }] })).body;
    const b = (await c.post('/contacts', { firstName: 'Ada', lastName: 'L.', jobTitle: 'Engineer', methods: [{ kind: 'phone', value: '+44 20 7946 0001' }] })).body;
    const d = (await c.post('/contacts', { firstName: 'A.', lastName: 'Lovelace', jobTitle: 'Countess', birthday: '1815-12-10', methods: [{ kind: 'email', value: 'ada@example.com' }, { kind: 'email', value: 'countess@example.com' }] })).body;
    const deal = (await c.post('/deals', { title: 'Engines', contactIds: [d.id] })).body;
    await c.post('/notes', { entityType: 'contact', entityId: b.id, body: 'Met at the conference' });

    const cmp = await c.get(`/merge/contact?ids=${a.id},${b.id},${d.id}`);
    expect(cmp.status).toBe(200);
    expect(cmp.body.records).toHaveLength(3);
    expect(cmp.body.max).toBe(10);

    // Job title from the third record, by id; birthday not chosen → first non-empty (the third); name stays (survivor's).
    const r = await c.post('/merge/contact', { survivorId: a.id, mergedIds: [b.id, d.id], choose: { jobTitle: d.id } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ id: a.id, mergedId: b.id, mergedIds: [b.id, d.id], undoId: expect.any(Number) });
    const kept = (await c.get(`/contacts/${a.id}`)).body;
    expect(kept).toMatchObject({ firstName: 'Ada', lastName: 'Lovelace', jobTitle: 'Countess', birthday: '1815-12-10' });
    expect(kept.methods.map((m: any) => m.value).sort()).toEqual(['+44 20 7946 0001', 'ada@example.com', 'countess@example.com']);
    expect(kept.deals.map((x: any) => x.id)).toEqual([deal.id]);
    const tl = (await c.get(`/timeline/contact/${a.id}`)).body.items;
    expect(tl.some((i: any) => i.type === 'note' && i.data.body === 'Met at the conference')).toBe(true);
    for (const gone of [b, d]) {
      const res = await c.get(`/contacts/${gone.id}`);
      expect(res.body.error).toMatchObject({ code: 'MERGED', details: { mergedIntoId: a.id } });
    }
    const hist = (await c.get(`/history/contact/${a.id}`)).body.data.filter((h: any) => h.action === 'merged');
    expect(hist.map((h: any) => h.changes.merged.id).sort()).toEqual([b.id, d.id].sort());

    // Validation: an id in `choose` must be part of the merge; at most 10 records; no duplicates/self.
    const x = (await c.post('/contacts', { firstName: 'X' })).body;
    const y = (await c.post('/contacts', { firstName: 'Y' })).body;
    expect((await c.post('/merge/contact', { survivorId: x.id, mergedIds: [y.id], choose: { jobTitle: 999999 } })).status).toBe(400);
    expect((await c.post('/merge/contact', { survivorId: x.id, mergedIds: [x.id] })).status).toBe(400);
    expect((await c.post('/merge/contact', { survivorId: x.id, mergedIds: Array.from({ length: 10 }, (_, i) => i + 1) })).status).toBe(400);
    expect((await c.post('/merge/contact', { survivorId: x.id })).status).toBe(400);
    expect((await c.get(`/merge/contact?ids=${x.id}`)).status).toBe(400);
  });

  it('merges leads: fields, contact details, products (when the kept lead has none), files; converted leads refused', async () => {
    const { c } = await signup();
    const a = (await c.post('/leads', { title: 'Robots inquiry', firstName: 'Bob', methods: [{ kind: 'email', value: 'bob@acme.test' }] })).body;
    const b = (await c.post('/leads', { title: 'Acme web form', firstName: 'Bob', lastName: 'Stone', companyName: 'Acme', amount: '900', methods: [{ kind: 'phone', value: '+1 555 0100' }] })).body;
    await c.put(`/leads/${b.id}/line-items`, { items: [{ name: 'Picker', unitPrice: '900', quantity: 1, unit: 'pcs' }] });
    await c.upload(`/attachments?entityType=lead&entityId=${b.id}&fileName=brief.pdf`, Buffer.from('%PDF-1.4'));

    const cmp = (await c.get(`/merge/lead?ids=${a.id},${b.id}`)).body;
    expect(cmp.fields.map((f: any) => f.key)).toContain('companyName');
    expect(cmp.records[1].related).toMatchObject({ products: 1 });
    expect(cmp.records.map((r: any) => r.companyName)).toEqual([null, 'Acme']); // the lead's own field, not overwritten

    const r = await c.post('/merge/lead', { survivorId: a.id, mergedId: b.id, choose: { name: 'merged' } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const kept = (await c.get(`/leads/${a.id}`)).body;
    expect(kept).toMatchObject({ title: 'Robots inquiry', firstName: 'Bob', lastName: 'Stone', companyName: 'Acme', amount: '900.00' });
    expect(kept.methods.map((m: any) => m.value).sort()).toEqual(['+1 555 0100', 'bob@acme.test']);
    expect(kept.lineItems.map((l: any) => l.name)).toEqual(['Picker']);
    expect((await c.get(`/attachments?entityType=lead&entityId=${a.id}`)).body.data.map((f: any) => f.fileName)).toEqual(['brief.pdf']);
    expect((await c.get(`/leads/${b.id}`)).body.error).toMatchObject({ code: 'MERGED', details: { mergedIntoId: a.id } });

    // Converted leads can't be merged.
    const conv = (await c.post('/leads', { title: 'Converted', firstName: 'Cy' })).body;
    await c.post(`/leads/${conv.id}/convert`, { contact: { mode: 'create' }, company: { mode: 'skip' }, deal: { create: false } });
    const refused = await c.post('/merge/lead', { survivorId: a.id, mergedId: conv.id });
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toContain('already converted');
  });

  it('finds similar names (typos, legal forms) for contacts, companies and leads; dismissals work for leads', async () => {
    const { c } = await signup();
    await c.post('/contacts', { firstName: 'Jonathan', lastName: 'Smith' });
    await c.post('/contacts', { firstName: 'Jonathon', lastName: 'Smith' });
    await c.post('/contacts', { firstName: 'Maria', lastName: 'Garcia' });
    const contacts = (await c.get('/duplicates/pairs?entityType=contact')).body.data;
    expect(contacts).toHaveLength(1);
    expect(contacts[0].reasons).toEqual([{ kind: 'similar_name', value: 'Jonathan Smith / Jonathon Smith' }]);

    await c.post('/companies', { name: 'Acme Robotics Ltd.' });
    await c.post('/companies', { name: 'ACME Robotics, Inc' });
    await c.post('/companies', { name: 'Globex' });
    const companies = (await c.get('/duplicates/pairs?entityType=company')).body.data;
    expect(companies).toHaveLength(1);
    expect(companies[0].reasons[0].kind).toBe('name'); // same once legal forms and case are ignored

    const l1 = (await c.post('/leads', { title: 'Web form', firstName: 'Kim', lastName: 'Lee', methods: [{ kind: 'email', value: 'kim@lee.test' }] })).body;
    const l2 = (await c.post('/leads', { title: 'Phone call', firstName: 'Kim', lastName: 'Lee', methods: [{ kind: 'email', value: 'KIM@lee.test' }] })).body;
    const leads = (await c.get('/duplicates/pairs?entityType=lead')).body.data;
    expect(leads).toHaveLength(1);
    expect(leads[0].reasons.map((r: any) => r.kind)).toEqual(['email', 'name']);
    expect(leads[0].left.title).toBe('Web form');
    expect((await c.post('/duplicates/dismiss', { entityType: 'lead', ids: [l2.id, l1.id] })).status).toBe(204);
    expect((await c.get('/duplicates/pairs?entityType=lead')).body.data).toEqual([]);
  });
});
