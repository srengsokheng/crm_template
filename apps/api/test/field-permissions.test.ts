import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.ts';
import { getApp, inviteUser, signup } from './helpers.ts';

afterAll(async () => { await (await getApp()).close(); await pool.end(); });

/** Workspace with a Sales rep whose role hides "Margin", locks "Region" and the deal amount, and locks contact owners. */
async function setup() {
  const s = await signup();
  const { c } = s;
  const margin = (await c.post('/fields', { entityType: 'deal', label: 'Margin', type: 'number' })).body;
  const region = (await c.post('/fields', { entityType: 'deal', label: 'Region', type: 'text' })).body;
  const roles = (await c.get('/roles')).body.data;
  const repRole = roles.find((r: any) => r.name === 'Sales rep');
  const rules = { deal: { [`custom.${margin.key}`]: 'hidden', [`custom.${region.key}`]: 'readonly', amount: 'readonly' }, contact: { ownerId: 'readonly' } };
  expect((await c.patch(`/roles/${repRole.id}`, { fieldRules: rules })).status).toBe(200);
  const rep = await inviteUser(c, 'Sales rep');
  // A deal the rep owns, with values set by the admin.
  const deal = (await c.post('/deals', { title: 'Robots', amount: '5000', ownerId: rep.id, custom: { [margin.key]: 32, [region.key]: 'APAC' } })).body;
  return { ...s, rep, deal, margin: margin.key as string, region: region.key as string, repRole, rules };
}

describe('field-level permissions', () => {
  it('hidden custom fields never reach the user: detail, writes, meta, history, timeline, export', async () => {
    const { c, rep, deal, margin, region } = await setup();
    const mine = (await rep.c.get(`/deals/${deal.id}`)).body;
    expect(mine.custom).toEqual({ [region]: 'APAC' });
    expect((await c.get(`/deals/${deal.id}`)).body.custom).toEqual({ [margin]: 32, [region]: 'APAC' }); // admins see everything
    expect((await rep.c.get('/meta')).body.fields.map((f: any) => f.key)).not.toContain(margin);
    expect((await rep.c.get('/auth/me')).body.fieldRules.deal[`custom.${margin}`]).toBe('hidden');

    // Writes that would set the hidden field are refused everywhere.
    const r = await rep.c.patch(`/deals/${deal.id}`, { custom: { [margin]: 50 } });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('FIELD_LOCKED');
    expect((await rep.c.post('/deals', { title: 'X', custom: { [margin]: 1 } })).status).toBe(403);
    const stages = (await rep.c.get('/meta')).body.pipelines.find((p: any) => p.id === deal.pipelineId).stages;
    expect((await rep.c.post(`/deals/${deal.id}/move`, { stageId: stages[1].id, custom: { [margin]: 9 } })).status).toBe(403);

    // The admin changes margin and title: the rep's history shows the title change only.
    await c.patch(`/deals/${deal.id}`, { custom: { [margin]: 40 } });
    await c.patch(`/deals/${deal.id}`, { title: 'Robots v2' });
    const hist = (await rep.c.get(`/history/deal/${deal.id}`)).body.data;
    expect(JSON.stringify(hist)).not.toContain('"' + margin + '"');
    expect(hist.filter((h: any) => h.action === 'updated').map((h: any) => Object.keys(h.changes))).toEqual([['title']]);
    const tl = JSON.stringify((await rep.c.get(`/timeline/deal/${deal.id}`)).body);
    expect(tl).not.toContain(margin);
    // Write responses are stripped too.
    const moved = (await rep.c.post(`/deals/${deal.id}/move`, { stageId: stages[1].id })).body;
    expect(moved.custom?.[margin]).toBeUndefined();

  });

  it('export leaves out hidden columns (role that may export)', async () => {
    const { c, rules } = await setup();
    const manager = (await c.get('/roles')).body.data.find((r: any) => r.name === 'Manager');
    await c.patch(`/roles/${manager.id}`, { fieldRules: rules });
    const m = await inviteUser(c, 'Manager', 'Mia');
    const head = (await m.c.download('/deals?format=csv')).body.toString('utf8').split('\n')[0];
    expect(head).toContain('Region');
    expect(head).not.toContain('Margin');
    expect((await c.download('/deals?format=csv')).body.toString('utf8').split('\n')[0]).toContain('Margin');
  });

  it('read-only fields: shown, unchanged values accepted, changes refused (incl. products and create)', async () => {
    const { c, rep, deal, region } = await setup();
    expect((await rep.c.get(`/deals/${deal.id}`)).body).toMatchObject({ amount: '5000.00', custom: { [region]: 'APAC' } });
    expect((await rep.c.patch(`/deals/${deal.id}`, { amount: '9000' })).status).toBe(403);
    expect((await rep.c.patch(`/deals/${deal.id}`, { amountMode: 'auto' })).status).toBe(403);
    expect((await rep.c.patch(`/deals/${deal.id}`, { custom: { [region]: 'EMEA' } })).status).toBe(403);
    expect((await rep.c.put(`/deals/${deal.id}/line-items`, { items: [{ name: 'X', unitPrice: '1', quantity: 1, unit: 'pcs' }] })).status).toBe(403);
    // Same values again (as a form would send them) and other fields are fine.
    const ok = await rep.c.patch(`/deals/${deal.id}`, { title: 'Renamed', amount: '5000.00', custom: { [region]: 'APAC' } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    // Create: locked fields may stay empty or at their default.
    expect((await rep.c.post('/deals', { title: 'New one' })).status).toBe(201);
    expect((await rep.c.post('/deals', { title: 'Priced', amount: '100' })).status).toBe(403);
    // Contacts: owner locked — creating with yourself as owner works, someone else doesn't, changing it doesn't.
    const me = await rep.c.post('/contacts', { firstName: 'Ann', ownerId: rep.id });
    expect(me.status).toBe(201);
    const adminId = (await c.get('/auth/me')).body.user.id;
    expect((await rep.c.post('/contacts', { firstName: 'Bob', ownerId: adminId })).status).toBe(403);
    expect((await rep.c.patch(`/contacts/${me.body.id}`, { ownerId: adminId })).status).toBe(403);
    expect((await rep.c.patch(`/contacts/${me.body.id}`, { jobTitle: 'CTO' })).status).toBe(200);
    // The admin isn't restricted by any of it.
    expect((await c.patch(`/deals/${deal.id}`, { amount: '7000' })).status).toBe(200);
  });

  it('merge: locked and hidden fields can’t be chosen and hidden values aren’t shown', async () => {
    const { c, rep, repRole } = await setup();
    const tier = (await c.post('/fields', { entityType: 'contact', label: 'Tier', type: 'text' })).body.key;
    const secret = (await c.post('/fields', { entityType: 'contact', label: 'Credit limit', type: 'text' })).body.key;
    await c.patch(`/roles/${repRole.id}`, { fieldRules: { contact: { [`custom.${tier}`]: 'readonly', [`custom.${secret}`]: 'hidden', jobTitle: 'readonly' } } });
    const a = (await rep.c.post('/contacts', { firstName: 'Keep' })).body;
    const b = (await rep.c.post('/contacts', { firstName: 'Gone' })).body;
    await c.patch(`/contacts/${a.id}`, { jobTitle: 'CEO', custom: { [tier]: 'Silver', [secret]: '10k' } });
    await c.patch(`/contacts/${b.id}`, { jobTitle: 'CTO', custom: { [tier]: 'Gold', [secret]: '50k' } });

    const preview = await rep.c.get(`/merge/contact?ids=${a.id},${b.id}`);
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(JSON.stringify(preview.body)).not.toContain('50k');
    expect(preview.body.customFields.map((f: any) => f.key)).toEqual([tier]);
    expect(preview.body.customFields[0].locked).toBe(true);
    expect(preview.body.fields.find((f: any) => f.key === 'jobTitle').locked).toBe(true);

    const merged = await rep.c.post('/merge/contact', { survivorId: a.id, mergedId: b.id, choose: { jobTitle: 'merged', [`custom.${tier}`]: 'merged', firstName: 'merged' } });
    expect(merged.status, JSON.stringify(merged.body)).toBe(200);
    const kept = (await c.get(`/contacts/${a.id}`)).body;
    expect(kept.jobTitle).toBe('CEO'); // choice ignored
    expect(kept.custom).toMatchObject({ [tier]: 'Silver', [secret]: '10k' });
  });

  it('roles: only admins set rules; standard fields can’t be hidden; unknown fields rejected; admin role exempt', async () => {
    const { c, rep, repRole } = await setup();
    expect((await rep.c.patch(`/roles/${repRole.id}`, { fieldRules: {} })).status).toBe(403);
    expect((await c.patch(`/roles/${repRole.id}`, { fieldRules: { deal: { amount: 'hidden' } } })).status).toBe(400);
    expect((await c.patch(`/roles/${repRole.id}`, { fieldRules: { deal: { nonsense: 'readonly' } } })).status).toBe(400);
    const admin = (await c.get('/roles')).body.data.find((r: any) => r.isAdmin);
    expect((await c.patch(`/roles/${admin.id}`, { fieldRules: { deal: { amount: 'readonly' } } })).status).toBe(400);
    expect((await c.get('/roles')).body.data.find((r: any) => r.id === repRole.id).fieldRules.deal.amount).toBe('readonly');
    // Clearing the rules lifts the restriction immediately.
    await c.patch(`/roles/${repRole.id}`, { fieldRules: {} });
    const deal = (await rep.c.post('/deals', { title: 'Free', amount: '10' }));
    expect(deal.status).toBe(201);
    // Another workspace's roles are untouched.
    const other = await signup('Other');
    expect((await other.c.get('/roles')).body.data.every((r: any) => JSON.stringify(r.fieldRules) === '{}')).toBe(true);
  });
});
