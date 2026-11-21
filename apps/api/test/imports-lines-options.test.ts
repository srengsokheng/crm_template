import { afterAll, describe, expect, it } from 'vitest';
import { processJobs, processOutbox } from '../src/automation/engine.ts';
import { pool } from '../src/db/pool.ts';
import { getApp, inviteUser, signup, type Client } from './helpers.ts';

afterAll(async () => { await (await getApp()).close(); await pool.end(); });
async function drain() { for (let n = 0; n < 100; n++) if (!((await processJobs(50)) + (await processOutbox()))) return; }

async function importAll(c: Client, entityType: string, content: string, options: Record<string, unknown> = {}) {
  const up = await c.post('/imports', { entityType, fileName: 'f.csv', content });
  expect(up.status, JSON.stringify(up.body)).toBe(201);
  const cfg = { mapping: up.body.mapping, options: { ...up.body.options, ...options } };
  const pv = await c.post(`/imports/${up.body.id}/preview`, cfg);
  expect(pv.status, JSON.stringify(pv.body)).toBe(200);
  const run = await c.post(`/imports/${up.body.id}/run`, cfg);
  expect(run.status, JSON.stringify(run.body)).toBe(200);
  await drain();
  return { id: up.body.id as number, upload: up.body, preview: pv.body, report: (await c.get(`/imports/${up.body.id}`)).body };
}

describe('import: products on deals', () => {
  it('adds product lines to existing deals (catalogue defaults, free-text lines), recalculates amounts, undo removes them', async () => {
    const { c } = await signup();
    await c.post('/products', { name: 'Picker robot', sku: 'PR-200', unitPrice: '1500', unit: 'pcs', taxRate: 10 });
    const acme = (await c.post('/deals', { title: 'Acme robots' })).body;
    const beta = (await c.post('/deals', { title: 'Beta pilot', amount: '999' })).body; // manual amount stays
    await c.post('/deals', { title: 'Twin' });
    await c.post('/deals', { title: 'Twin' });
    const csv = [
      'Deal,Product,Qty,Unit price,Discount %',
      'Acme robots,PR-200,2,,10%',
      'acme ROBOTS,Installation (2 days),1,800,',
      `Beta pilot,picker robot,1,,`,
      'Twin,PR-200,1,,',
      'Nowhere,PR-200,1,,',
      'Acme robots,Mystery part,1,,',
      'Acme robots,PR-200,0,,',
    ].join('\n');
    const { upload, preview, report, id } = await importAll(c, 'deal_line', csv);
    expect(upload.mapping).toEqual(['deal', 'product', 'quantity', 'unitPrice', 'discount']);
    expect(upload.options.matchBy).toEqual([]);
    expect(preview.summary).toMatchObject({ create: 3, error: 4 });
    expect(preview.problems.map((p: any) => p.message)).toEqual([
      'Deal: 2 deals are called "Twin" — add a Deal ID column',
      'Deal: no deal called "Nowhere" that you can see (deals are not created by this import)',
      'Unit price: "Mystery part" is not in the product list, so a price is needed',
      'Quantity: must be more than 0',
    ]);
    expect(report).toMatchObject({ status: 'done', created: 3, failed: 4 });

    const a = (await c.get(`/deals/${acme.id}`)).body;
    expect(a.lineItems.map((l: any) => [l.name, l.quantity, l.unitPrice, l.lineTotal])).toEqual([
      ['Picker robot', '2.000', '1500.00', '2970.00'], // 2 × 1500, −10 %, +10 % tax (from the catalogue)
      ['Installation (2 days)', '1.000', '800.00', '800.00'],
    ]);
    expect(a.amount).toBe('3770.00');
    expect((await c.get(`/deals/${beta.id}`)).body.amount).toBe('999.00'); // manual amount untouched
    expect(JSON.stringify((await c.get(`/history/deal/${acme.id}`)).body.data)).toContain(`"_import":{"id":${id}`);

    const undo = (await c.post(`/imports/${id}/undo`, {})).body;
    expect(undo).toMatchObject({ deleted: 3, notAllowed: 0 });
    const after = (await c.get(`/deals/${acme.id}`)).body;
    expect(after.lineItems).toEqual([]);
    expect(after.amount).toBe('0.00');
  });

  it('uses the deal import permission and edit rights; locked amounts are refused; Deal ID disambiguates', async () => {
    const { c } = await signup();
    const t1 = (await c.post('/deals', { title: 'Twin' })).body;
    await c.post('/deals', { title: 'Twin' });
    const r = await importAll(c, 'deal_line', `Deal ID,Product,Unit price\n${t1.id},Widget,10\n#${t1.id},Gadget,5`);
    expect(r.report).toMatchObject({ created: 2, failed: 0 });
    expect((await c.get(`/deals/${t1.id}`)).body.amount).toBe('15.00');

    const rep = await inviteUser(c, 'Sales rep');
    expect((await rep.c.post('/imports', { entityType: 'deal_line', fileName: 'x.csv', content: 'Deal,Product\nTwin,X' })).status).toBe(403); // no deal import
    const roles = (await c.get('/roles')).body.data;
    const repRole = roles.find((x: any) => x.name === 'Sales rep');
    await c.patch(`/roles/${repRole.id}`, { grants: { ...repRole.grants, deal: { ...repRole.grants.deal, import: 'all' } } });
    const own = (await rep.c.post('/deals', { title: 'Rep deal' })).body;
    // The admin's deals aren't editable for the rep (own scope); their own deal is.
    const res = await importAll(rep.c, 'deal_line', `Deal ID,Product,Unit price\n${t1.id},X,1\n${own.id},Y,2`);
    expect(res.preview.problems.map((p: any) => p.message)).toEqual([expect.stringMatching(/^Deal (ID: no deal|: you can’t edit)/)]);
    expect(res.report).toMatchObject({ created: 1, failed: 1 });
    // Amount locked for the role → every row refused.
    await c.patch(`/roles/${repRole.id}`, { fieldRules: { deal: { amount: 'readonly' } } });
    const locked = await importAll(rep.c, 'deal_line', `Deal ID,Product,Unit price\n${own.id},Z,3`);
    expect(locked.preview.problems[0].message).toBe('Your role can’t change deal amounts or products');
    expect(locked.report.created).toBe(0);
  });
});

describe('import: new options for custom select fields', () => {
  it('admins can add missing select/multiselect options; others get the row error', async () => {
    const { c } = await signup();
    const seg = (await c.post('/fields', { entityType: 'contact', label: 'Segment', type: 'select', options: [{ id: 'smb', label: 'SMB' }] })).body;
    const tags = (await c.post('/fields', { entityType: 'contact', label: 'Interests', type: 'multiselect', options: [{ id: 'robots', label: 'Robots' }] })).body;
    const csv = 'Name,Segment,Interests\nAda Lovelace,Enterprise,Robots; Drones\nGrace Hopper,enterprise,Drones\nAlan Turing,SMB,';
    const off = await importAll(c, 'contact', csv);
    expect(off.preview.summary).toMatchObject({ create: 1, error: 2 });

    const on = await importAll(c, 'contact', csv.replace('Alan Turing,SMB,', 'Alan Kay,SMB,'), { addMissingOptions: true });
    expect(on.preview.summary).toMatchObject({ create: 3, error: 0, newOptions: 2 });
    expect(on.report).toMatchObject({ created: 3, failed: 0 });
    const meta = (await c.get('/meta')).body.fields;
    expect(meta.find((f: any) => f.key === seg.key).options).toEqual([{ id: 'smb', label: 'SMB' }, { id: 'enterprise', label: 'Enterprise' }]);
    expect(meta.find((f: any) => f.key === tags.key).options.map((o: any) => o.label)).toEqual(['Robots', 'Drones']);
    const ada = (await c.get('/contacts?q=Ada')).body.data[0];
    expect((await c.get(`/contacts/${ada.id}`)).body.custom).toEqual({ [seg.key]: 'enterprise', [tags.key]: ['robots', 'drones'] });

    // A Manager (not an admin) with the option set still gets the error.
    const m = await inviteUser(c, 'Manager');
    const up = (await m.c.post('/imports', { entityType: 'contact', fileName: 'm.csv', content: 'Name,Segment\nBob,Mid-market' })).body;
    const pv = (await m.c.post(`/imports/${up.id}/preview`, { mapping: up.mapping, options: { ...up.options, addMissingOptions: true } })).body;
    expect(pv.summary).toMatchObject({ create: 0, error: 1, newOptions: 0 });
  });
});
