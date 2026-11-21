import { afterAll, describe, expect, it } from 'vitest';
import { q, sql } from '../src/db/index.ts';
import { pool } from '../src/db/pool.ts';
import { getApp, inviteUser, signup } from './helpers.ts';

afterAll(async () => { await (await getApp()).close(); await pool.end(); });

describe('merge contacts', () => {
  it('keeps chosen values, fills gaps, moves everything over, keeps history and retires the duplicate', async () => {
    const { c, dict } = await signup();
    const field = (await c.post('/fields', { entityType: 'contact', label: 'Tier', type: 'text' })).body;
    const acme = (await c.post('/companies', { name: 'Acme' })).body;
    const globex = (await c.post('/companies', { name: 'Globex' })).body;
    const keep = (await c.post('/contacts', {
      firstName: 'Ada', lastName: 'Lovelace', jobTitle: 'Engineer', primaryCompanyId: acme.id,
      methods: [{ kind: 'email', value: 'ada@example.com' }],
    })).body;
    const dup = (await c.post('/contacts', {
      firstName: 'Ada', lastName: 'L.', jobTitle: 'Head of Engineering', birthday: '1815-12-10', custom: { [field.key]: 'Gold' },
      typeId: dict('contact_type')[0].id, companyIds: [acme.id, globex.id],
      methods: [{ kind: 'email', value: 'ADA@example.com' }, { kind: 'phone', value: '+1 555 0100' }],
    })).body;
    await c.patch(`/contacts/${dup.id}`, { description: 'From the trade show' }); // history on the duplicate
    // Things attached to the duplicate (and one deal attached to both).
    const shared = (await c.post('/deals', { title: 'Shared deal', contactIds: [keep.id, dup.id] })).body;
    const dupDeal = (await c.post('/deals', { title: 'Dup deal', contactIds: [dup.id] })).body;
    const act = (await c.post('/activities', { kind: 'task', subject: 'Call Ada', links: [{ entityType: 'contact', entityId: dup.id }, { entityType: 'contact', entityId: keep.id }] })).body;
    await c.post('/notes', { entityType: 'contact', entityId: dup.id, body: 'Prefers email' });

    const cmp = await c.get(`/merge/contact?ids=${keep.id},${dup.id}`);
    expect(cmp.status).toBe(200);
    expect(cmp.body.records.map((r: any) => [r.title, r.related])).toEqual([
      ['Ada Lovelace', { deals: 1, companies: 1, activities: 1, notes: 0 }],
      ['Ada L.', { deals: 2, companies: 2, activities: 1, notes: 1 }],
    ]);
    expect(cmp.body.records[1]).toMatchObject({ canKeep: true, canRemove: true });

    const r = await c.post('/merge/contact', { survivorId: keep.id, mergedId: dup.id, choose: { jobTitle: 'merged' } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ id: keep.id, mergedId: dup.id, mergedIds: [dup.id], undoId: expect.any(Number) });

    const after = (await c.get(`/contacts/${keep.id}`)).body;
    expect(after).toMatchObject({
      firstName: 'Ada', lastName: 'Lovelace', // name kept (not chosen)
      jobTitle: 'Head of Engineering', // chosen from the duplicate
      birthday: '1815-12-10', typeId: dict('contact_type')[0].id, description: 'From the trade show', // gaps filled
      custom: { [field.key]: 'Gold' }, primaryCompanyId: acme.id,
    });
    expect(after.methods.map((m: any) => [m.kind, m.value, m.isPrimary])).toEqual([['email', 'ada@example.com', true], ['phone', '+1 555 0100', true]]);
    expect(after.companies.map((x: any) => x.name)).toEqual(['Acme', 'Globex']);
    expect(after.deals.map((d: any) => d.title).sort()).toEqual(['Dup deal', 'Shared deal']);
    const sharedDeal = (await c.get(`/deals/${shared.id}`)).body;
    expect(sharedDeal.contacts.map((x: any) => x.id)).toEqual([keep.id]); // not listed twice
    expect((await c.get(`/deals/${dupDeal.id}`)).body.contacts.map((x: any) => x.id)).toEqual([keep.id]);
    const tl = (await c.get(`/timeline/contact/${keep.id}`)).body;
    expect(tl.items.filter((i: any) => i.type === 'note').map((n: any) => n.data.body)).toEqual(['Prefers email']);
    expect(tl.upcoming.map((a: any) => a.subject)).toEqual(['Call Ada']);
    const links = await q(sql`SELECT entity_id FROM activity_links WHERE activity_id = ${act.id} ORDER BY entity_id`);
    expect(links.map((l: any) => Number(l.entity_id))).toEqual([keep.id]);

    // History: the duplicate's events moved over and the merge itself is recorded.
    const hist = (await c.get(`/history/contact/${keep.id}`)).body.data;
    const merged = hist.find((h: any) => h.action === 'merged');
    expect(merged.changes).toMatchObject({ merged: { id: dup.id, name: 'Ada L.' }, job_title: ['Engineer', 'Head of Engineering'], movedMethods: 1 });
    expect(hist.filter((h: any) => h.action === 'created')).toHaveLength(2);
    expect(hist.filter((h: any) => h.action === 'created').map((h: any) => h.changes._from ?? null)).toEqual([{ id: dup.id, name: 'Ada L.' }, null]);
    expect(hist.some((h: any) => h.action === 'updated' && h.changes.description)).toBe(true);
    expect(merged.actorType).toBe('user');

    // The duplicate is gone, says where it went, and is not restorable or listed in the recycle bin.
    const gone = await c.get(`/contacts/${dup.id}`);
    expect(gone.status).toBe(404);
    expect(gone.body.error).toMatchObject({ code: 'MERGED', details: { mergedIntoId: keep.id } });
    expect((await c.get('/contacts')).body.total).toBe(1);
    expect((await c.get('/recycle-bin')).body.data).toEqual([]);
    expect((await c.post(`/contacts/${dup.id}/restore`)).status).toBe(400);
    expect((await c.get(`/duplicates?email=ada@example.com`)).body.data.map((h: any) => h.id)).toEqual([keep.id]);
  });

  it('follows chains: a record merged into one that is merged later points to the final record', async () => {
    const { c } = await signup();
    const [a, b, d] = await Promise.all(['A', 'B', 'D'].map(async (n) => (await c.post('/contacts', { firstName: n })).body));
    expect((await c.post('/merge/contact', { survivorId: b.id, mergedId: a.id })).status).toBe(200);
    expect((await c.post('/merge/contact', { survivorId: d.id, mergedId: b.id })).status).toBe(200);
    expect((await c.get(`/contacts/${a.id}`)).body.error.details).toEqual({ mergedIntoId: d.id });
  });

  it('validates the pair', async () => {
    const { c } = await signup();
    const a = (await c.post('/contacts', { firstName: 'A' })).body;
    const b = (await c.post('/contacts', { firstName: 'B' })).body;
    expect((await c.post('/merge/contact', { survivorId: a.id, mergedId: a.id })).status).toBe(400);
    expect((await c.get(`/merge/contact?ids=${a.id}`)).status).toBe(400);
    expect((await c.post('/merge/deal', { survivorId: a.id, mergedId: b.id })).status).toBe(404);
    expect((await c.post('/merge/contact', { survivorId: a.id, mergedId: 999999 })).status).toBe(404);
    expect((await c.post('/merge/contact', { survivorId: a.id, mergedId: b.id, choose: { name: 'sideways' } })).status).toBe(400);
    expect((await c.post('/merge/contact', { survivorId: a.id, mergedId: b.id })).status).toBe(200);
    expect((await c.post('/merge/contact', { survivorId: a.id, mergedId: b.id })).status).toBe(404); // already merged
  });
});

describe('merge companies', () => {
  it('moves deals, contacts (incl. main company) and links without duplicates', async () => {
    const { c } = await signup();
    const keep = (await c.post('/companies', { name: 'Globex Corporation', methods: [{ kind: 'website', value: 'https://globex.example.com' }] })).body;
    const dup = (await c.post('/companies', { name: 'Globex Corp', annualRevenue: '1000000', currency: 'EUR', methods: [{ kind: 'website', value: 'globex.example.com/' }] })).body;
    const both = (await c.post('/contacts', { firstName: 'Both', companyIds: [keep.id, dup.id], primaryCompanyId: dup.id })).body;
    const only = (await c.post('/contacts', { firstName: 'Only', primaryCompanyId: dup.id })).body;
    const deal = (await c.post('/deals', { title: 'Big order', companyId: dup.id })).body;
    const r = await c.post('/merge/company', { survivorId: keep.id, mergedId: dup.id });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const after = (await c.get(`/companies/${keep.id}`)).body;
    expect(after).toMatchObject({ name: 'Globex Corporation', annualRevenue: '1000000.00', currency: 'EUR' });
    expect(after.methods).toHaveLength(1); // same website, normalised
    expect(after.contacts.map((x: any) => x.firstName).sort()).toEqual(['Both', 'Only']);
    expect(after.deals.map((d: any) => d.id)).toEqual([deal.id]);
    expect((await c.get(`/contacts/${both.id}`)).body).toMatchObject({ primaryCompanyId: keep.id });
    expect((await c.get(`/contacts/${both.id}`)).body.companies.map((x: any) => x.id)).toEqual([keep.id]);
    expect((await c.get(`/contacts/${only.id}`)).body.primaryCompanyId).toBe(keep.id);
    expect((await c.get(`/companies/${dup.id}`)).body.error.code).toBe('MERGED');
  });
});

describe('merge permissions and isolation', () => {
  it('needs edit on the kept record and delete on the merged one', async () => {
    const { c: admin } = await signup();
    const rep = await inviteUser(admin, 'Sales rep', 'Rita'); // contacts: view all, edit team, delete own
    const viewer = await inviteUser(admin, 'Viewer', 'Vic');
    const mine1 = (await rep.c.post('/contacts', { firstName: 'Mine1' })).body;
    const mine2 = (await rep.c.post('/contacts', { firstName: 'Mine2' })).body;
    const adminsA = (await admin.post('/contacts', { firstName: 'AdminA' })).body;
    const adminsB = (await admin.post('/contacts', { firstName: 'AdminB' })).body;

    // Rep may not delete (merge away) the admin's record, nor edit (keep) it — they are not in a team together.
    expect((await rep.c.post('/merge/contact', { survivorId: mine1.id, mergedId: adminsA.id })).status).toBe(403);
    expect((await rep.c.post('/merge/contact', { survivorId: adminsA.id, mergedId: mine1.id })).status).toBe(403);
    expect((await viewer.c.post('/merge/contact', { survivorId: adminsA.id, mergedId: adminsB.id })).status).toBe(403);
    const cmp = (await rep.c.get(`/merge/contact?ids=${mine1.id},${adminsA.id}`)).body;
    expect(cmp.records.map((r: any) => [r.canKeep, r.canRemove])).toEqual([[true, true], [false, false]]);
    // Nothing changed by the refused attempts.
    expect((await admin.get(`/contacts/${adminsA.id}`)).status).toBe(200);
    expect((await rep.c.post('/merge/contact', { survivorId: mine1.id, mergedId: mine2.id })).status).toBe(200);
  });

  it('keeps workspaces apart', async () => {
    const a = await signup('Alpha');
    const b = await signup('Beta');
    const a1 = (await a.c.post('/contacts', { firstName: 'A1' })).body;
    const b1 = (await b.c.post('/contacts', { firstName: 'B1' })).body;
    const b2 = (await b.c.post('/contacts', { firstName: 'B2' })).body;
    expect((await a.c.post('/merge/contact', { survivorId: a1.id, mergedId: b1.id })).status).toBe(404);
    expect((await a.c.post('/merge/contact', { survivorId: b1.id, mergedId: b2.id })).status).toBe(404);
    expect((await a.c.get(`/merge/contact?ids=${b1.id},${b2.id}`)).status).toBe(404);
    expect((await b.c.get(`/contacts/${b1.id}`)).status).toBe(200);
  });
});

describe('duplicate hints', () => {
  it('finds companies sharing a website, however it was typed', async () => {
    const { c } = await signup();
    const a = (await c.post('/companies', { name: 'Initech Logistics', methods: [{ kind: 'website', value: 'https://www.initech.example.com/' }] })).body;
    const hits = (await c.get('/duplicates?website=initech.example.com&excludeType=company&excludeId=0')).body.data;
    expect(hits.map((h: any) => [h.id, h.matchedOn])).toEqual([[a.id, 'website']]);
  });
});
