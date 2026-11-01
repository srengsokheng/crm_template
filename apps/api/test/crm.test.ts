/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.ts';
import { getApp, signup } from './helpers.ts';

afterAll(async () => { await (await getApp()).close(); await pool.end(); });

describe('contacts & companies', () => {
  it('creates, lists, searches, sorts and paginates contacts with totals', async () => {
    const { c } = await signup();
    const co = await c.post('/companies', { name: 'Acme Robotics', methods: [{ kind: 'website', value: 'https://acme.example.com' }] });
    expect(co.status).toBe(201);
    const names = ['Zoe', 'Ben', 'Mia', 'Cara', 'Dan'];
    for (const [i, n] of names.entries()) {
      const r = await c.post('/contacts', {
        firstName: n, lastName: `Bulk${i}`, primaryCompanyId: i === 0 ? co.body.id : undefined,
        methods: [{ kind: 'email', value: `${n.toLowerCase()}@example.com` }, { kind: 'phone', value: `+1 555 010 00${i}${i}` }],
      });
      expect(r.status).toBe(201);
    }
    const page1 = await c.get('/contacts?pageSize=2&sort=name');
    expect(page1.body.total).toBe(5);
    expect(page1.body.data.map((x: any) => x.firstName)).toEqual(['Ben', 'Cara']);
    const page3 = await c.get('/contacts?pageSize=2&page=3&sort=name');
    expect(page3.body.data.map((x: any) => x.firstName)).toEqual(['Zoe']);
    expect((await c.get('/contacts?sort=-name&pageSize=1')).body.data[0].firstName).toBe('Zoe');
    expect((await c.get('/contacts?q=MIA')).body.total).toBe(1);
    expect((await c.get('/contacts?q=5550100')).body.total).toBeGreaterThanOrEqual(1);
    expect((await c.get('/contacts?q=acme')).body.data[0].firstName).toBe('Zoe');
    expect((await c.get(`/contacts?companyId=${co.body.id}`)).body.total).toBe(1);
    expect((await c.get('/contacts?sort=bogus')).status).toBe(400);
    const company = (await c.get(`/companies/${co.body.id}`)).body;
    expect(company.contacts).toHaveLength(1);
    expect(company.methods[0].value).toBe('https://acme.example.com');
  });

  it('validates input and enforces optimistic locking', async () => {
    const { c } = await signup();
    expect((await c.post('/contacts', { firstName: '  ' })).status).toBe(400);
    const bad = await c.post('/contacts', { firstName: 'A', methods: [{ kind: 'email', value: 'not-an-email' }] });
    expect(bad.status).toBe(400);
    expect(bad.body.error.fields['methods.0.value']).toMatch(/email/i);
    expect((await c.post('/companies', { name: '' })).status).toBe(400);
    const ct = (await c.post('/contacts', { firstName: 'Lock' })).body;
    expect((await c.patch(`/contacts/${ct.id}`, { jobTitle: 'CEO', version: ct.version })).status).toBe(200);
    const stale = await c.patch(`/contacts/${ct.id}`, { jobTitle: 'CTO', version: ct.version });
    expect(stale.status).toBe(409);
    const hist = (await c.get(`/history/contact/${ct.id}`)).body.data;
    expect(hist.find((h: any) => h.action === 'updated').changes.job_title).toEqual([null, 'CEO']);
  });

  it('finds duplicates by email/phone across leads, contacts and companies', async () => {
    const { c } = await signup();
    await c.post('/contacts', { firstName: 'Alice', lastName: 'Tester', methods: [{ kind: 'email', value: 'Alice.Tester@Example.com' }] });
    await c.post('/leads', { title: 'Inbound', methods: [{ kind: 'phone', value: '+1 (555) 010-0199' }] });
    const d1 = await c.get('/duplicates?email=alice.tester@example.com');
    expect(d1.body.data).toEqual([expect.objectContaining({ entityType: 'contact', matchedOn: 'email' })]);
    const d2 = await c.get('/duplicates?phone=%2B15550100199');
    expect(d2.body.data[0]).toMatchObject({ entityType: 'lead', matchedOn: 'phone' });
    const d3 = await c.get('/duplicates?name=alice%20tester');
    expect(d3.body.data[0].matchedOn).toMatch(/email|name/);
  });
});

describe('deals & pipelines', () => {
  it('moves deals through stages, wins, loses with reason, reopens; board and list aggregates', async () => {
    const { c, dealPipeline, stage, dict } = await signup();
    const d1 = (await c.post('/deals', { title: 'Big deal', amount: '15000' })).body;
    expect(d1.stageId).toBe(stage(dealPipeline, 'New').id);
    expect(d1.amountMode).toBe('manual');
    const d2 = (await c.post('/deals', { title: 'Small deal', amount: '2500', stageId: stage(dealPipeline, 'Qualified').id })).body;
    const moved = await c.post(`/deals/${d1.id}/move`, { stageId: stage(dealPipeline, 'Proposal').id });
    expect(moved.body.stageId).toBe(stage(dealPipeline, 'Proposal').id);
    expect(moved.body.probability).toBe(50);
    const board = (await c.get(`/deals/board?pipelineId=${dealPipeline.id}`)).body;
    const stat = (name: string) => board.stats.find((s: any) => s.stageId === stage(dealPipeline, name).id);
    expect(stat('Proposal')).toMatchObject({ count: 1, sum: '15000.00' });
    expect(stat('Qualified')).toMatchObject({ count: 1, sum: '2500.00' });

    const won = (await c.post(`/deals/${d1.id}/close`, { outcome: 'won' })).body;
    expect(won.status).toBe('won');
    expect(won.closedAt).toBeTruthy();
    const lostReason = dict('lost_reason')[0];
    const lost = (await c.post(`/deals/${d2.id}/close`, { outcome: 'lost', lostReasonId: lostReason.id, lostNote: 'Too pricey' })).body;
    expect(lost.status).toBe('lost');
    expect(lost.lostReasonId).toBe(lostReason.id);
    expect((await c.get('/deals?status=open')).body.total).toBe(0);
    const list = (await c.get('/deals')).body;
    expect(list.aggregates.amountSum).toBe('17500.00');

    const reopened = (await c.post(`/deals/${d2.id}/reopen`)).body;
    expect(reopened.status).toBe('open');
    expect(reopened.stageId).toBe(stage(dealPipeline, 'Qualified').id);
    expect(reopened.closedAt).toBeNull();
    const history = (await c.get(`/history/deal/${d2.id}`)).body.data.map((h: any) => h.action);
    expect(history).toEqual(expect.arrayContaining(['created', 'lost', 'reopened']));
  });

  it('rejects stages from another pipeline and enforces required-from-stage custom fields', async () => {
    const { c, dealPipeline, leadPipeline, stage } = await signup();
    const field = await c.post('/fields', {
      entityType: 'deal', label: 'Customer segment', type: 'select',
      options: [{ id: 'smb', label: 'SMB' }, { id: 'ent', label: 'Enterprise' }],
      required: 'from_stage', requiredStageIds: [stage(dealPipeline, 'Proposal').id],
    });
    expect(field.status).toBe(201);
    expect(field.body.key).toBe('customer_segment');
    const d = (await c.post('/deals', { title: 'Needs segment' })).body;
    expect((await c.post(`/deals/${d.id}/move`, { stageId: leadPipeline.stages[0].id })).status).toBe(400);
    const blocked = await c.post(`/deals/${d.id}/move`, { stageId: stage(dealPipeline, 'Proposal').id });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe('REQUIRED_FIELDS');
    expect(blocked.body.error.details[0]).toMatchObject({ key: 'customer_segment', type: 'select' });
    const badValue = await c.post(`/deals/${d.id}/move`, { stageId: stage(dealPipeline, 'Proposal').id, custom: { customer_segment: 'nope' } });
    expect(badValue.status).toBe(400);
    const ok = await c.post(`/deals/${d.id}/move`, { stageId: stage(dealPipeline, 'Proposal').id, custom: { customer_segment: 'smb' } });
    expect(ok.status).toBe(200);
    expect(ok.body.custom).toEqual({ customer_segment: 'smb' });
    // Clearing a required value while in that stage is refused.
    expect((await c.patch(`/deals/${d.id}`, { custom: { customer_segment: null } })).status).toBe(422);
  });

  it('computes line items server-side and keeps auto amounts consistent', async () => {
    const { c } = await signup();
    const p = (await c.post('/products', { name: 'Robotic Arm X1', unitPrice: '4500', taxRate: 10 })).body;
    const d = (await c.post('/deals', { title: 'Arms' })).body;
    expect(d.amountMode).toBe('auto');
    const r = await c.put(`/deals/${d.id}/line-items`, {
      items: [
        { productId: p.id, name: 'Robotic Arm X1', unitPrice: '4500', quantity: 3, taxRate: 10 },
        { name: 'Installation', unitPrice: '1500', quantity: 1, discountType: 'percent', discountValue: 10 },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.body.lineItems.map((l: any) => l.lineTotal)).toEqual(['14850.00', '1350.00']);
    expect(r.body.amount).toBe('16200.00');
    expect(r.body.totals).toMatchObject({ listTotal: '15000.00', discount: '150.00', tax: '1350.00', total: '16200.00' });
    // Manual override sticks; switching back to auto recalculates.
    await c.patch(`/deals/${d.id}`, { amount: '20000' });
    expect((await c.get(`/deals/${d.id}`)).body).toMatchObject({ amount: '20000.00', amountMode: 'manual' });
    await c.patch(`/deals/${d.id}`, { amountMode: 'auto' });
    expect((await c.get(`/deals/${d.id}`)).body.amount).toBe('16200.00');
    expect((await c.put(`/deals/${d.id}/line-items`, { items: [{ name: 'X', unitPrice: '1', quantity: 0 }] })).status).toBe(400);
  });

  it('manages pipelines and stages safely', async () => {
    const { c } = await signup();
    const pid = (await c.post('/pipelines', { entityType: 'deal', name: 'Partnerships' })).body.id;
    const meta = (await c.get('/meta')).body;
    const pl = meta.pipelines.find((p: any) => p.id === pid);
    expect(pl.stages.map((s: any) => s.kind)).toEqual(['open', 'open', 'open', 'open', 'won', 'lost']);
    const added = (await c.post(`/pipelines/${pid}/stages`, { name: 'Demo', color: 'violet' })).body;
    expect(added.sort).toBe(4);
    expect((await c.post(`/pipelines/${pid}/stages`, { name: 'Won again', kind: 'won' })).status).toBe(400);
    const d = (await c.post('/deals', { title: 'P deal', pipelineId: pid, stageId: added.id })).body;
    expect((await c.del(`/stages/${added.id}`)).status).toBe(400);
    expect((await c.del(`/stages/${added.id}`, { moveToStageId: pl.stages[0].id })).status).toBe(204);
    expect((await c.get(`/deals/${d.id}`)).body.stageId).toBe(pl.stages[0].id);
    expect((await c.del(`/pipelines/${pid}`)).status).toBe(400); // still has a deal
  });
});

describe('leads & conversion', () => {
  it('validates leads, auto-titles them and converts to contact + company + deal in one step', async () => {
    const { c, leadPipeline, stage } = await signup();
    const empty = await c.post('/leads', {});
    expect(empty.status).toBe(400);
    const lead = (await c.post('/leads', {
      firstName: 'Alice', lastName: 'Tester', companyName: 'Acme Robotics', jobTitle: 'Head of Procurement', amount: '15000',
      methods: [{ kind: 'email', value: 'alice@acme.example.com' }, { kind: 'phone', value: '+1 555 010 0199' }],
    })).body;
    expect(lead.title).toBe('Acme Robotics');
    expect(lead.stageId).toBe(stage(leadPipeline, 'New').id);
    // Won stage is only reachable through conversion.
    expect((await c.post(`/leads/${lead.id}/move`, { stageId: stage(leadPipeline, 'Converted').id })).status).toBe(400);
    await c.post(`/leads/${lead.id}/move`, { stageId: stage(leadPipeline, 'Qualified').id });
    const act = (await c.post('/activities', { kind: 'call', subject: 'Call Alice', dueAt: new Date(Date.now() + 86400000).toISOString(), links: [{ entityType: 'lead', entityId: lead.id }] })).body;
    await c.post('/notes', { entityType: 'lead', entityId: lead.id, body: 'Wants 3 arms' });

    const preview = (await c.get(`/leads/${lead.id}/convert-preview`)).body;
    expect(preview).toMatchObject({ contactName: 'Alice Tester', companyName: 'Acme Robotics', contactMatches: [], companyMatches: [] });

    const conv = await c.post(`/leads/${lead.id}/convert`, { contact: { mode: 'create' }, company: { mode: 'create' }, deal: { create: true } });
    expect(conv.status).toBe(200);
    const { dealId, contactId, companyId } = conv.body;
    const deal = (await c.get(`/deals/${dealId}`)).body;
    expect(deal).toMatchObject({ title: 'Acme Robotics', amount: '15000.00', companyId, leadId: lead.id });
    expect(deal.contacts[0]).toMatchObject({ id: contactId, firstName: 'Alice' });
    expect(deal.contacts[0].methods.map((m: any) => m.kind).sort()).toEqual(['email', 'phone']);
    const contact = (await c.get(`/contacts/${contactId}`)).body;
    expect(contact.companies[0].id).toBe(companyId);
    expect(contact.jobTitle).toBe('Head of Procurement');
    const after = (await c.get(`/leads/${lead.id}`)).body;
    expect(after.status).toBe('won');
    expect(after.converted.deal.id).toBe(dealId);
    // The open activity followed the lead to the new records (still open), and the timeline shows the lead's note.
    const dealTimeline = (await c.get(`/timeline/deal/${dealId}`)).body;
    expect(dealTimeline.upcoming.map((a: any) => a.id)).toContain(act.id);
    expect(dealTimeline.items.some((i: any) => i.type === 'note' && i.data.body === 'Wants 3 arms')).toBe(true);
    expect((await c.post(`/leads/${lead.id}/convert`, { contact: { mode: 'create' }, company: { mode: 'skip' }, deal: { create: false } })).status).toBe(400);

    // Second lead for the same person: preview suggests the existing contact; convert links to it.
    const lead2 = (await c.post('/leads', { firstName: 'Alice', lastName: 'Tester', methods: [{ kind: 'email', value: 'alice@acme.example.com' }] })).body;
    const p2 = (await c.get(`/leads/${lead2.id}/convert-preview`)).body;
    expect(p2.contactMatches[0].id).toBe(contactId);
    const conv2 = (await c.post(`/leads/${lead2.id}/convert`, { contact: { mode: 'existing', id: contactId }, company: { mode: 'skip' }, deal: { create: true, title: 'Repeat order' } })).body;
    expect(conv2.contactId).toBe(contactId);
    expect((await c.get(`/contacts/${contactId}`)).body.deals).toHaveLength(2);
  });

  it('disqualifies leads with a reason', async () => {
    const { c, dict } = await signup();
    const lead = (await c.post('/leads', { title: 'Spammy' })).body;
    const r = await c.post(`/leads/${lead.id}/disqualify`, { reasonId: dict('disqualify_reason')[1].id, note: 'Spam form' });
    expect(r.body.status).toBe('lost');
    const tl = (await c.get(`/timeline/lead/${lead.id}`)).body;
    expect(tl.items.some((i: any) => i.type === 'event' && i.data.action === 'disqualified')).toBe(true);
  });
});

describe('activities, notes, recycle bin, search, reports', () => {
  it('tracks activities by bucket and completion', async () => {
    const { c } = await signup();
    const d = (await c.post('/deals', { title: 'Act deal' })).body;
    const past = new Date(Date.now() - 3600_000).toISOString();
    const future = new Date(Date.now() + 3 * 86400_000).toISOString();
    const a1 = (await c.post('/activities', { kind: 'task', subject: 'Overdue task', dueAt: past, links: [{ entityType: 'deal', entityId: d.id }] })).body;
    await c.post('/activities', { kind: 'meeting', subject: 'Future meeting', dueAt: future });
    await c.post('/activities', { kind: 'task', subject: 'Someday' });
    expect((await c.get('/activities/counts')).body).toMatchObject({ overdue: 1, upcoming: 1, nodate: 1 });
    expect((await c.get('/activities?bucket=overdue')).body.data[0].links[0]).toMatchObject({ entityType: 'deal', entityId: d.id, title: 'Act deal' });
    const listed = (await c.get(`/deals?pageSize=5`)).body.data.find((x: any) => x.id === d.id);
    expect(listed.nextActivity.subject).toBe('Overdue task');
    const done = await c.patch(`/activities/${a1.id}`, { status: 'done' });
    expect(done.body.status).toBe('done');
    expect(done.body.completedAt).toBeTruthy();
    expect((await c.get('/activities/counts')).body.overdue).toBe(0);
    expect((await c.get('/activities?bucket=done')).body.total).toBe(1);
    const tl = (await c.get(`/timeline/deal/${d.id}`)).body;
    expect(tl.items.find((i: any) => i.type === 'activity').data.subject).toBe('Overdue task');
    expect((await c.post('/activities', { kind: 'task', subject: 'X', links: [{ entityType: 'deal', entityId: 999999 }] })).status).toBe(404);
  });

  it('soft-deletes to the recycle bin and restores with the same id', async () => {
    const { c } = await signup();
    const ct = (await c.post('/contacts', { firstName: 'Restore', lastName: 'Me' })).body;
    expect((await c.del(`/contacts/${ct.id}`)).status).toBe(204);
    expect((await c.get(`/contacts/${ct.id}`)).status).toBe(404);
    const bin = (await c.get('/recycle-bin')).body.data;
    expect(bin[0]).toMatchObject({ entity: 'contacts', id: ct.id, title: 'Restore Me' });
    expect((await c.post(`/contacts/${ct.id}/restore`)).status).toBe(200);
    expect((await c.get(`/contacts/${ct.id}`)).body.id).toBe(ct.id);
    expect((await c.get('/recycle-bin')).body.data).toHaveLength(0);
  });

  it('global search covers all record types', async () => {
    const { c } = await signup();
    await c.post('/companies', { name: 'Globex Corporation' });
    await c.post('/deals', { title: 'Globex renewal' });
    await c.post('/contacts', { firstName: 'Hank', lastName: 'Scorpio', methods: [{ kind: 'email', value: 'hank@globex.example.com' }] });
    const r = (await c.get('/search?q=globex')).body.data.map((x: any) => x.type).sort();
    expect(r).toEqual(['company', 'contact', 'deal']);
  });

  it('reports and dashboard match the data exactly', async () => {
    const { c, dict } = await signup();
    const a = (await c.post('/deals', { title: 'Won A', amount: '15000' })).body;
    const b = (await c.post('/deals', { title: 'Lost B', amount: '2500' })).body;
    await c.post('/deals', { title: 'Open C', amount: '1000', expectedCloseDate: '2020-01-01' });
    await c.post(`/deals/${a.id}/close`, { outcome: 'won' });
    await c.post(`/deals/${b.id}/close`, { outcome: 'lost', lostReasonId: dict('lost_reason')[0].id });
    const dash = (await c.get('/dashboard')).body;
    expect(dash.kpis).toMatchObject({ openAmount: '1000.00', openCount: 1, wonAmount: '15000.00', wonCount: 1, lostCount: 1, winRate: 50, overdueDeals: 1 });
    expect(dash.byStage.find((s: any) => s.name === 'New')).toMatchObject({ count: 1, amount: '1000.00' });
    const won = (await c.get('/reports/won-deals')).body;
    expect(won.totals).toEqual({ count: 1, amount: '15000.00' });
    const byOwner = (await c.get('/reports/deals-by-owner')).body.rows[0];
    expect(byOwner).toMatchObject({ deals: 3, open: 1, won: 1, lost: 1, wonAmount: '15000.00', winRate: 50 });
    const overdue = (await c.get('/reports/overdue-deals')).body.rows;
    expect(overdue.map((r: any) => r.title)).toEqual(['Open C']);
    const csv = await c.get('/reports/won-deals?format=csv');
    expect(typeof csv.body).toBe('string');
    expect(csv.body.split('\n')[0]).toContain('title');
    expect((await c.get('/reports/nope')).status).toBe(400);
  });
});
