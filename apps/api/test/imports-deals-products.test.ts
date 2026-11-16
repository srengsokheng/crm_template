import { afterAll, describe, expect, it } from 'vitest';
import { processJobs, processOutbox } from '../src/automation/engine.ts';
import { q, sql } from '../src/db/index.ts';
import { pool } from '../src/db/pool.ts';
import { getApp, inviteUser, signup, type Client } from './helpers.ts';

afterAll(async () => { await (await getApp()).close(); await pool.end(); });

async function drain() {
  for (let n = 0; n < 100; n++) if (!((await processJobs(50)) + (await processOutbox()))) return;
}

async function importAll(c: Client, entityType: string, content: string, options: Record<string, unknown> = {}) {
  const up = await c.post('/imports', { entityType, fileName: `${entityType}s.csv`, content });
  expect(up.status, JSON.stringify(up.body)).toBe(201);
  const cfg = { mapping: up.body.mapping, options: { ...up.body.options, ...options } };
  const pv = await c.post(`/imports/${up.body.id}/preview`, cfg);
  expect(pv.status, JSON.stringify(pv.body)).toBe(200);
  const run = await c.post(`/imports/${up.body.id}/run`, cfg);
  expect(run.status, JSON.stringify(run.body)).toBe(200);
  await drain();
  return { id: up.body.id as number, upload: up.body, preview: pv.body, report: (await c.get(`/imports/${up.body.id}`)).body };
}

describe('CSV import — deals', () => {
  it('maps, links companies and contacts, sets stages (incl. won), skips duplicates by title, undo', async () => {
    const { c } = await signup();
    const ada = (await c.post('/contacts', { firstName: 'Ada', lastName: 'Lovelace', methods: [{ kind: 'email', value: 'ada@example.com' }] })).body;
    const grace = (await c.post('/contacts', { firstName: 'Grace', lastName: 'Hopper' })).body;
    await c.post('/deals', { title: 'Existing deal' });
    const csv = [
      'Deal name,Value,Stage,Close date,Probability,Account,Contact,Type,Source,Notes',
      'Robots for Acme,"12,500.00",Proposal,2026-12-01,60%,Acme Robotics,ada@example.com,New business,Referral,Big one',
      'Warehouse pilot,3000,Won,2026-10-15,,Acme Robotics,Grace Hopper; ada@example.com,,,',
      'existing DEAL,99,,,,,,,,',
      'Ghost contact,10,,,,,nobody@example.com,,,',
      'Bad stage,10,Nowhere,,,,,,,',
    ].join('\n');
    const { upload, preview, report, id } = await importAll(c, 'deal', csv, { duplicateMode: 'skip', matchBy: ['name'] });
    expect(upload.mapping).toEqual(['title', 'amount', 'stage', 'expectedCloseDate', 'probability', 'company', 'contact', 'dealType', 'source', 'description']);
    expect(preview.summary).toMatchObject({ create: 2, skip: 1, error: 2, newCompanies: 1 });
    expect(preview.problems.map((p: any) => p.message)).toEqual([
      'Contact: no contact with the email "nobody@example.com"',
      'Stage: no stage called "Nowhere" in the deal pipeline',
    ]);
    expect(report).toMatchObject({ status: 'done', created: 2, skipped: 1, failed: 2 });

    const deals = (await c.get('/deals?q=Acme&pageSize=50')).body.data;
    const robots = (await c.get(`/deals/${deals.find((d: any) => d.title === 'Robots for Acme').id}`)).body;
    expect(robots).toMatchObject({ amount: '12500.00', expectedCloseDate: '2026-12-01', probability: 60, description: 'Big one', status: 'open' });
    expect(robots.contacts.map((x: any) => x.id)).toEqual([ada.id]);
    expect(robots.company.name).toBe('Acme Robotics');
    const pilot = (await c.get(`/deals/${deals.find((d: any) => d.title === 'Warehouse pilot').id}`)).body;
    expect(pilot.status).toBe('won');
    expect(pilot.contacts.map((x: any) => x.id).sort()).toEqual([ada.id, grace.id].sort());
    expect(pilot.company.id).toBe(robots.company.id); // one company created, reused
    // History shows the import; no automation ran (default off).
    expect(JSON.stringify((await c.get(`/history/deal/${robots.id}`)).body.data)).toContain(`"_import":{"id":${id}`);

    const undo = await c.post(`/imports/${id}/undo`, {});
    expect(undo.body).toMatchObject({ deleted: 2, notAllowed: 0 });
    expect((await c.get(`/deals/${robots.id}`)).status).toBe(404);
  });

  it('updates matching deals, adding contacts; respects permissions and restricted pipelines', async () => {
    const { c } = await signup();
    const ada = (await c.post('/contacts', { firstName: 'Ada', methods: [{ kind: 'email', value: 'ada@example.com' }] })).body;
    const deal = (await c.post('/deals', { title: 'Renewal 2027', amount: '100' })).body;
    const { report } = await importAll(c, 'deal', 'Deal name,Amount,Contact\nRenewal 2027,250,ada@example.com', { duplicateMode: 'update', matchBy: ['name'] });
    expect(report).toMatchObject({ updated: 1, created: 0 });
    const after = (await c.get(`/deals/${deal.id}`)).body;
    expect(after.amount).toBe('250.00');
    expect(after.contacts.map((x: any) => x.id)).toEqual([ada.id]);

    // A rep without import permission for deals can't even upload a deal file.
    const rep = await inviteUser(c, 'Sales rep');
    expect((await rep.c.post('/imports', { entityType: 'deal', fileName: 'd.csv', content: 'Deal name\nX' })).status).toBe(403);
    // With the permission granted, deals in a pipeline the role may not use can't be targeted.
    const roles = (await c.get('/roles')).body.data;
    const repRole = roles.find((r: any) => r.name === 'Sales rep');
    await c.patch(`/roles/${repRole.id}`, { grants: { ...repRole.grants, deal: { ...repRole.grants.deal, import: 'all' } } });
    const vip = (await c.post('/pipelines', { entityType: 'deal', name: 'VIP' })).body;
    await c.patch(`/pipelines/${vip.id}`, { allowedRoleIds: [roles.find((r: any) => r.name === 'Manager').id] });
    const up = await rep.c.post('/imports', { entityType: 'deal', fileName: 'd.csv', content: 'Deal name\nSecret' });
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    const pv = await rep.c.post(`/imports/${up.body.id}/preview`, { mapping: up.body.mapping, options: { ...up.body.options, pipelineId: vip.id } });
    expect(pv.status).toBe(400);
    expect(pv.body.error.message).toBe('Deal pipeline not found');
  });
});

describe('CSV import — products', () => {
  it('imports products with price, tax, unit, active flag; matches by SKU; categories must exist unless added', async () => {
    const { c } = await signup();
    await c.post('/product-categories', { name: 'Robots' });
    const csv = [
      'Product,SKU,Unit price,Currency,Unit,VAT %,Tax included,Category,Active,Description',
      'Picker robot,PR-200,"1,500.00",USD,pcs,10%,no,Robots,yes,Our best seller',
      'Gripper,GR-1,89.9,,pcs,10,yes,Spare parts,yes,',
      'Old model,PR-100,900,,,,,robots,no,',
    ].join('\n');
    const first = await importAll(c, 'product', csv);
    expect(first.upload.mapping).toEqual(['name', 'sku', 'unitPrice', 'currency', 'unit', 'taxRate', 'taxIncluded', 'category', 'isActive', 'description']);
    expect(first.upload.options.matchBy).toEqual(['sku']);
    expect(first.report).toMatchObject({ created: 2, failed: 1 });
    expect(first.preview.problems[0].message).toBe('Category: "Spare parts" doesn\'t exist. Add it under Products, or don\'t import this column');
    const list = (await c.get('/products?pageSize=50')).body.data;
    expect(list.find((p: any) => p.sku === 'PR-200')).toMatchObject({ name: 'Picker robot', unitPrice: '1500.00', taxRate: '10.00', taxIncluded: false, isActive: true, categoryName: 'Robots' });
    expect(list.find((p: any) => p.sku === 'PR-100')).toMatchObject({ isActive: false, categoryName: 'Robots' });

    // Second run: admin adds missing categories; PR-200 is updated by SKU (price change), not duplicated.
    const second = await importAll(c, 'product', csv.replace('"1,500.00"', '1600'), { duplicateMode: 'update', addMissingOptions: true });
    expect(second.preview.summary).toMatchObject({ update: 2, create: 1, newOptions: 1 });
    expect(second.report).toMatchObject({ updated: 2, created: 1, failed: 0 });
    const after = (await c.get('/products?pageSize=50')).body.data;
    expect(after.filter((p: any) => p.sku === 'PR-200')).toHaveLength(1);
    expect(after.find((p: any) => p.sku === 'PR-200').unitPrice).toBe('1600.00');
    expect(after.find((p: any) => p.sku === 'GR-1')).toMatchObject({ categoryName: 'Spare parts', taxIncluded: true });
    // Product changes are now in the audit log.
    const [ev] = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM audit_events WHERE entity_type = 'product' AND changes ? '_import'`);
    expect(ev.n).toBeGreaterThanOrEqual(3);
  });

  it('"add missing list options" creates list values for admins only; others still get a row error', async () => {
    const { c } = await signup();
    const csv = 'Company name,Industry\nAcme,Space mining\nBeta,Space Mining';
    const admin = await importAll(c, 'company', csv, { addMissingOptions: true });
    expect(admin.preview.summary).toMatchObject({ create: 2, error: 0, newOptions: 1 });
    expect(admin.report.created).toBe(2);
    const opts = (await c.get('/meta')).body.dictionaries.filter((d: any) => d.kind === 'industry' && d.label.toLowerCase() === 'space mining');
    expect(opts).toHaveLength(1); // one value, used by both rows

    const manager = await inviteUser(c, 'Manager');
    const up = await manager.c.post('/imports', { entityType: 'company', fileName: 'c.csv', content: 'Company name,Industry\nGamma,Deep sea' });
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    const pv = await manager.c.post(`/imports/${up.body.id}/preview`, { mapping: up.body.mapping, options: { ...up.body.options, addMissingOptions: true } });
    expect(pv.body.summary).toMatchObject({ create: 0, error: 1, newOptions: 0 });
    expect(pv.body.problems[0].message).toContain('"Deep sea" is not in the list');
  });
});
