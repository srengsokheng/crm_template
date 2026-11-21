import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.ts';
import { getApp, inviteUser, signup } from './helpers.ts';

afterAll(async () => { await (await getApp()).close(); await pool.end(); });

/** Admin + Manager (allowed) + another Manager-like role (blocked), a restricted "VIP" deal pipeline with one deal. */
async function setup() {
  const s = await signup();
  const { c: admin } = s;
  const roles = (await admin.get('/roles')).body.data;
  const managerRole = roles.find((r: any) => r.name === 'Manager');
  const outsiderRole = (await admin.post('/roles', { name: 'Outsider', grants: Object.fromEntries(['deal', 'lead', 'contact', 'company', 'activity'].map((e) =>
    [e, { view: 'all', create: 'all', edit: 'all', delete: 'all', export: 'all' }])) })).body;
  const insider = await inviteUser(admin, 'Manager', 'Ina Insider');
  const outsider = await inviteUser(admin, 'Outsider', 'Otto Outsider');
  const vip = (await admin.post('/pipelines', { entityType: 'deal', name: 'VIP' })).body;
  const vipStages = (await admin.get('/meta')).body.pipelines.find((p: any) => p.id === vip.id).stages;
  const company = (await admin.post('/companies', { name: 'Secret Buyer Ltd' })).body;
  const contact = (await admin.post('/contacts', { firstName: 'Sam', lastName: 'Secret', primaryCompanyId: company.id })).body;
  const deal = (await admin.post('/deals', { title: 'VIP mega deal', amount: '999999', pipelineId: vip.id, companyId: company.id, contactIds: [contact.id] })).body;
  const act = (await admin.post('/activities', { kind: 'call', subject: 'Call about it', assigneeId: outsider.id, links: [{ entityType: 'deal', entityId: deal.id }] })).body;
  const normal = (await admin.post('/deals', { title: 'Normal deal', amount: '10' })).body;
  expect((await admin.patch(`/pipelines/${vip.id}`, { allowedRoleIds: [managerRole.id] })).status).toBe(200);
  return { ...s, admin, insider, outsider, vip, vipStages, company, contact, deal, act, normal, managerRole, outsiderRole };
}

describe('pipeline access', () => {
  it('hides a restricted pipeline and its deals from a blocked role everywhere', async () => {
    const t = await setup();
    const o = t.outsider.c;
    expect((await o.get('/meta')).body.pipelines.map((p: any) => p.name)).not.toContain('VIP');
    expect((await o.get(`/deals/${t.deal.id}`)).status).toBe(403);
    expect((await o.get('/deals')).body.data.map((d: any) => d.title)).toEqual(['Normal deal']);
    expect((await o.get(`/deals/board?pipelineId=${t.vip.id}`)).body.leads ?? (await o.get(`/deals/board?pipelineId=${t.vip.id}`)).body.deals).toEqual([]);
    expect((await o.get('/search?q=mega')).body.data ?? []).toEqual([]);
    expect((await o.get(`/contacts/${t.contact.id}`)).body.deals).toEqual([]);
    expect((await o.get(`/companies/${t.company.id}`)).body.deals).toEqual([]);
    expect((await o.get('/companies')).body.data[0].openDealsCount).toBe(0);
    const tl = (await o.get(`/timeline/company/${t.company.id}`)).body;
    expect(JSON.stringify(tl)).not.toContain('VIP mega deal');
    const acts = (await o.get('/activities?bucket=all&assigneeId=me')).body.data;
    const myAct = (await o.get(`/activities?assigneeId=me&bucket=nodate`)).body.data.concat(acts).find((a: any) => a.id === t.act.id);
    if (myAct) expect(myAct.links[0].title).toBe('Restricted deal');
    expect((await o.get(`/timeline/deal/${t.deal.id}`)).status).toBe(403);
    const dash = (await o.get('/dashboard')).body;
    expect(JSON.stringify(dash)).not.toContain('999999');
    const report = (await o.get('/reports/expected-sales')).body;
    expect(JSON.stringify(report)).not.toContain('VIP mega deal');
    const csv = await o.raw('GET', '/deals?format=csv', { headers: {} });
    expect(String(csv.body)).not.toContain('VIP mega deal');
  });

  it('does not let a blocked role create, edit or move deals into the pipeline', async () => {
    const t = await setup();
    const o = t.outsider.c;
    expect((await o.post('/deals', { title: 'Sneaky', pipelineId: t.vip.id })).status).toBe(403);
    expect((await o.post('/deals', { title: 'Sneaky 2', stageId: t.vipStages[0].id })).status).toBe(403);
    expect((await o.patch(`/deals/${t.deal.id}`, { title: 'Renamed' })).status).toBe(403);
    expect((await o.post(`/deals/${t.deal.id}/move`, { stageId: t.vipStages[1].id })).status).toBe(403);
    expect((await o.patch(`/deals/${t.normal.id}`, { pipelineId: t.vip.id })).status).toBe(403);
    expect((await o.del(`/deals/${t.deal.id}`)).status).toBe(403);
    expect((await o.post('/notes', { entityType: 'deal', entityId: t.deal.id, body: 'peek' })).status).toBe(403);
    expect((await o.post('/activities', { kind: 'task', subject: 'x', links: [{ entityType: 'deal', entityId: t.deal.id }] })).status).toBe(403);
    // A new deal without a pipeline still lands in one the role may use.
    const ok = await o.post('/deals', { title: 'Allowed' });
    expect(ok.status).toBe(201);
    expect(ok.body.pipelineId).not.toBe(t.vip.id);
  });

  it('lets allowed roles and admins work normally; a blocked default pipeline is skipped', async () => {
    const t = await setup();
    expect((await t.insider.c.get(`/deals/${t.deal.id}`)).status).toBe(200);
    expect((await t.insider.c.patch(`/deals/${t.deal.id}`, { title: 'VIP mega deal 2' })).status).toBe(200);
    expect((await t.admin.get(`/deals/${t.deal.id}`)).status).toBe(200);
    expect((await t.insider.c.get('/meta')).body.pipelines.map((p: any) => p.name)).toContain('VIP');
    // Make VIP the default: the outsider's new deals still go to a pipeline they may use.
    await t.admin.patch(`/pipelines/${t.vip.id}`, { isDefault: true });
    const d = await t.outsider.c.post('/deals', { title: 'Default check' });
    expect(d.status).toBe(201);
    expect(d.body.pipelineId).not.toBe(t.vip.id);
    // Opening it up again restores access.
    expect((await t.admin.patch(`/pipelines/${t.vip.id}`, { allowedRoleIds: null })).status).toBe(200);
    expect((await t.outsider.c.get(`/deals/${t.deal.id}`)).status).toBe(200);
  });

  it('validates the setting: admins only, known roles only', async () => {
    const t = await setup();
    expect((await t.insider.c.patch(`/pipelines/${t.vip.id}`, { allowedRoleIds: null })).status).toBe(403);
    expect((await t.admin.patch(`/pipelines/${t.vip.id}`, { allowedRoleIds: [999999] })).status).toBe(400);
    const other = await signup('Other');
    const otherRole = (await other.c.get('/roles')).body.data[1];
    expect((await t.admin.patch(`/pipelines/${t.vip.id}`, { allowedRoleIds: [otherRole.id] })).status).toBe(400); // another workspace's role
    expect((await t.admin.get('/meta')).body.pipelines.find((p: any) => p.id === t.vip.id).allowedRoleIds).toEqual([t.managerRole.id]);
  });
});
