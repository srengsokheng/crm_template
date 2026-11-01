/* Demo workspace seeded through the real API (validation, automation and audit all apply).
 * Usage: npm run db:seed   →  sign in as demo@example.com / demo12345
 */
import { buildApp } from '../app.ts';
import { processJobs, processOutbox } from '../automation/engine.ts';
import { migrate } from './migrate.ts';
import { pool } from './pool.ts';
import { q1, sql } from './index.ts';

const EMAIL = process.env.SEED_EMAIL ?? 'demo@example.com';
const PASSWORD = process.env.SEED_PASSWORD ?? 'demo12345';

await migrate(() => {});
if (await q1(sql`SELECT 1 FROM users WHERE email = ${EMAIL}`)) {
  console.log(`${EMAIL} already exists — nothing to do.`);
  await pool.end();
  process.exit(0);
}
const app = await buildApp({ logger: false });

function client() {
  let cookie = '';
  const send = async (method: string, url: string, body?: unknown) => {
    const res = await app.inject({ method: method as 'GET', url: `/api/v1${url}`, payload: body === undefined ? undefined : JSON.stringify(body),
      headers: { cookie, 'x-requested-with': 'crm', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) } });
    const sc = res.headers['set-cookie'];
    if (sc) cookie = (Array.isArray(sc) ? sc : [sc]).map((s) => s.split(';')[0]).find((s) => s.startsWith('crm_session=')) ?? cookie;
    if (res.statusCode >= 400) throw new Error(`${method} ${url} → ${res.statusCode} ${res.body}`);
    return res.body ? JSON.parse(res.body) : undefined;
  };
  return { get: (u: string) => send('GET', u), post: (u: string, b: unknown = {}) => send('POST', u, b), patch: (u: string, b: unknown) => send('PATCH', u, b), put: (u: string, b: unknown) => send('PUT', u, b) };
}

const admin = client();
await admin.post('/auth/signup', { workspaceName: 'Acme Robotics', name: 'Sreng Sokheng', email: EMAIL, password: PASSWORD });
let meta = await admin.get('/meta');
const roles = (await admin.get('/roles')).data as { id: number; name: string }[];
const role = (n: string) => roles.find((r) => r.name === n)!.id;

// Team members (invited + accepted so they can own records)
const people: Record<string, number> = {};
for (const [name, r] of [['Dara Chan', 'Sales rep'], ['Mia Lopez', 'Sales rep'], ['Omar Haddad', 'Manager']] as const) {
  const email = `${name.split(' ')[0].toLowerCase()}@example.com`;
  const inv = await admin.post('/users/invite', { email, name, roleId: role(r) });
  const u = client();
  await u.post('/auth/accept-invite', { token: inv.inviteUrl.split('/invite/')[1], name, password: PASSWORD });
  people[name] = (await u.get('/auth/me')).user.id;
}
const me = (await admin.get('/auth/me')).user.id as number;
await admin.post('/teams', { name: 'Field sales', memberIds: [people['Dara Chan'], people['Mia Lopez'], people['Omar Haddad']] });
await admin.post('/product-categories', { name: 'Robots' });
await admin.post('/product-categories', { name: 'Services' });
meta = await admin.get('/meta');
const cat = (n: string) => meta.productCategories.find((c: { name: string }) => c.name === n).id;
const dict = (kind: string, label: string) => meta.dictionaries.find((d: { kind: string; label: string }) => d.kind === kind && d.label === label)?.id ?? null;
const deal = meta.pipelines.find((p: { entityType: string }) => p.entityType === 'deal');
const lead = meta.pipelines.find((p: { entityType: string }) => p.entityType === 'lead');
const st = (p: { stages: { name: string; id: number }[] }, n: string) => p.stages.find((s) => s.name === n)!.id;

// Custom field + automation
await admin.post('/fields', { entityType: 'deal', label: 'Customer segment', type: 'select', options: [{ id: 'smb', label: 'SMB' }, { id: 'mid', label: 'Mid-market' }, { id: 'ent', label: 'Enterprise' }], required: 'from_stage', requiredStageIds: [st(deal, 'Proposal')], helpText: 'Needed before sending a proposal' });
await admin.post('/automation-rules', { entityType: 'deal', pipelineId: deal.id, stageId: st(deal, 'Proposal'), trigger: 'stage_entered', action: 'create_activity', config: { kind: 'task', subject: 'Send proposal for {{title}}', dueInDays: 1, assignTo: 'owner' } });
await admin.post('/automation-rules', { entityType: 'deal', pipelineId: deal.id, stageId: st(deal, 'Negotiation'), trigger: 'stage_entered', delayMinutes: 4320, action: 'notify', config: { userId: 'owner', title: '{{title}} has been in negotiation for 3 days', message: 'Check in with the customer.' } });

// Products
const products: Record<string, { id: number; unitPrice: string }> = {};
for (const [name, price, c, sku, tax] of [
  ['Robotic Arm X1', '4500', 'Robots', 'RA-X1', 10], ['Robotic Arm X2 Pro', '7800', 'Robots', 'RA-X2', 10], ['Vision Kit', '1200', 'Robots', 'VK-1', 10],
  ['Installation', '1500', 'Services', 'SRV-INST', null], ['Annual maintenance', '2400', 'Services', 'SRV-MAINT', null], ['Operator training (day)', '650', 'Services', 'SRV-TRN', null],
] as const) {
  products[name] = await admin.post('/products', { name, unitPrice: price, categoryId: cat(c), sku, taxRate: tax, unit: c === 'Services' ? 'service' : 'pcs' });
}

// Companies & contacts
const companies: Record<string, number> = {};
const contacts: Record<string, number> = {};
const data: [string, string, string, string, string, [string, string, string][]][] = [
  ['Globex Manufacturing', 'Manufacturing', '51–200', 'Customer', 'globex.example.com', [['Hank', 'Scorpio', 'COO'], ['Lena', 'Park', 'Procurement lead']]],
  ['Initech Logistics', 'Construction', '201–1000', 'Prospect', 'initech.example.com', [['Peter', 'Gibbons', 'Operations manager']]],
  ['Umbrella Foods', 'Retail', '1000+', 'Prospect', 'umbrella.example.com', [['Alice', 'Abernathy', 'Head of automation'], ['Carlos', 'Oliveira', 'Plant engineer']]],
  ['Stark Components', 'Technology', '201–1000', 'Customer', 'stark.example.com', [['Pepper', 'Potts', 'CEO']]],
  ['Wayne Packaging', 'Manufacturing', '51–200', 'Prospect', 'wayne.example.com', [['Lucius', 'Fox', 'CTO']]],
  ['Soylent Kitchens', 'Hospitality', '11–50', 'Prospect', 'soylent.example.com', [['Sol', 'Roth', 'Owner']]],
  ['Cyberdyne Systems', 'Technology', '201–1000', 'Partner', 'cyberdyne.example.com', [['Miles', 'Dyson', 'Engineering director']]],
  ['Tyrell Medical', 'Healthcare', '51–200', 'Prospect', 'tyrell.example.com', [['Rachael', 'Rosen', 'Lab manager']]],
];
const owners = [me, people['Dara Chan'], people['Mia Lopez'], people['Omar Haddad']];
let i = 0;
for (const [name, ind, size, type, site, ppl] of data) {
  const co = await admin.post('/companies', { name, industryId: dict('industry', ind), sizeId: dict('company_size', size), typeId: dict('company_type', type), ownerId: owners[i % 4], methods: [{ kind: 'website', value: `https://${site}` }, { kind: 'phone', value: `+1 555 01${String(10 + i).padStart(2, '0')} 000` }] });
  companies[name] = co.id;
  for (const [f, l, t] of ppl) {
    const domain = site;
    const c = await admin.post('/contacts', { firstName: f, lastName: l, jobTitle: t, primaryCompanyId: co.id, typeId: dict('contact_type', type === 'Customer' ? 'Customer' : 'Prospect'), ownerId: owners[i % 4],
      methods: [{ kind: 'email', value: `${f.toLowerCase()}.${l.toLowerCase()}@${domain}` }, { kind: 'phone', value: `+1 555 02${String(i).padStart(2, '0')} ${String(1000 + Object.keys(contacts).length)}` }] });
    contacts[`${f} ${l}`] = c.id;
  }
  i++;
}

// Deals across stages
const day = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const deals: { title: string; co: string; ct: string; stage: string; amount?: string; items?: [string, number][]; owner: number; close: number; seg?: string; outcome?: 'won' | 'lost' }[] = [
  { title: 'Globex — 3 robotic arms', co: 'Globex Manufacturing', ct: 'Hank Scorpio', stage: 'Negotiation', items: [['Robotic Arm X1', 3], ['Installation', 1], ['Annual maintenance', 1]], owner: me, close: 10, seg: 'mid' },
  { title: 'Initech warehouse pilot', co: 'Initech Logistics', ct: 'Peter Gibbons', stage: 'Qualified', amount: '18000', owner: people['Dara Chan'], close: 25 },
  { title: 'Umbrella packing line', co: 'Umbrella Foods', ct: 'Alice Abernathy', stage: 'Proposal', items: [['Robotic Arm X2 Pro', 4], ['Vision Kit', 4], ['Operator training (day)', 3]], owner: people['Mia Lopez'], close: 18, seg: 'ent' },
  { title: 'Stark — maintenance renewal', co: 'Stark Components', ct: 'Pepper Potts', stage: 'New', items: [['Annual maintenance', 2]], owner: people['Omar Haddad'], close: 40 },
  { title: 'Wayne vision upgrade', co: 'Wayne Packaging', ct: 'Lucius Fox', stage: 'New', amount: '6000', owner: people['Dara Chan'], close: -3 },
  { title: 'Soylent kitchen robot', co: 'Soylent Kitchens', ct: 'Sol Roth', stage: 'Qualified', amount: '9500', owner: people['Mia Lopez'], close: 30 },
  { title: 'Cyberdyne reseller bundle', co: 'Cyberdyne Systems', ct: 'Miles Dyson', stage: 'Negotiation', items: [['Robotic Arm X1', 6], ['Vision Kit', 6]], owner: me, close: 7, seg: 'ent', outcome: 'won' },
  { title: 'Globex second line', co: 'Globex Manufacturing', ct: 'Lena Park', stage: 'Proposal', items: [['Robotic Arm X1', 2]], owner: people['Omar Haddad'], close: 5, seg: 'mid', outcome: 'won' },
  { title: 'Tyrell lab automation', co: 'Tyrell Medical', ct: 'Rachael Rosen', stage: 'Proposal', amount: '22000', owner: people['Dara Chan'], close: -10, seg: 'smb', outcome: 'lost' },
  { title: 'Umbrella spare parts', co: 'Umbrella Foods', ct: 'Carlos Oliveira', stage: 'Qualified', amount: '3200', owner: me, close: 60 },
];
for (const d of deals) {
  const created = await admin.post('/deals', { title: d.title, companyId: companies[d.co], contactIds: [contacts[d.ct]], ownerId: d.owner, expectedCloseDate: day(d.close), amount: d.amount, dealTypeId: dict('deal_type', 'New business'), sourceId: dict('lead_source', 'Referral') });
  if (d.items) await admin.put(`/deals/${created.id}/line-items`, { items: d.items.map(([n, qty]) => ({ productId: products[n].id, name: n, unitPrice: products[n].unitPrice, quantity: qty, taxRate: n.startsWith('Robotic') || n === 'Vision Kit' ? 10 : null })) });
  const order = ['New', 'Qualified', 'Proposal', 'Negotiation'];
  for (const s of order.slice(1, order.indexOf(d.stage) + 1)) {
    await admin.post(`/deals/${created.id}/move`, { stageId: st(deal, s), custom: s === 'Proposal' && d.seg ? { customer_segment: d.seg } : undefined });
  }
  if (d.outcome === 'won') await admin.post(`/deals/${created.id}/close`, { outcome: 'won' });
  if (d.outcome === 'lost') await admin.post(`/deals/${created.id}/close`, { outcome: 'lost', lostReasonId: dict('lost_reason', 'Chose a competitor'), lostNote: 'Went with a cheaper local integrator' });
  if (!d.outcome) {
    await admin.post('/activities', { kind: d.close < 0 ? 'call' : 'meeting', subject: d.close < 0 ? `Call ${d.ct.split(' ')[0]} about timing` : `Demo for ${d.co}`, dueAt: new Date(Date.now() + (d.close < 0 ? -864e5 : Math.min(d.close, 6) * 864e5)).toISOString(), assigneeId: d.owner, links: [{ entityType: 'deal', entityId: created.id }, { entityType: 'contact', entityId: contacts[d.ct] }] });
  }
  await admin.post('/notes', { entityType: 'deal', entityId: created.id, body: `Kick-off with ${d.ct}. Budget confirmed for this quarter.` });
}

// Leads
for (const [f, l, co, src, title, email] of [
  ['Ellen', 'Ripley', 'Weyland Freight', 'Website', 'Website inquiry: palletising robot', 'ellen@weyland.example.com'],
  ['Marty', 'McFly', 'Hill Valley Motors', 'Event', 'Met at Automation Expo', 'marty@hillvalley.example.com'],
  ['Sarah', 'Connor', '', 'Phone call', '', '+1 555 0303 111'],
  ['Arthur', 'Dent', 'Magrathea Builders', 'Referral', 'Referral from Globex', 'arthur@magrathea.example.com'],
  ['Ford', 'Prefect', 'Guide Media', 'Advertising', 'Ad campaign response', 'ford@guide.example.com'],
] as const) {
  const isPhone = email.startsWith('+');
  const ld = await admin.post('/leads', { firstName: f, lastName: l, companyName: co || null, title: title || null, sourceId: dict('lead_source', src), amount: String(5000 + Math.round(Math.random() * 20) * 500),
    ownerId: owners[Math.floor(Math.random() * 4)], methods: [{ kind: isPhone ? 'phone' : 'email', value: email }] });
  if (f === 'Marty') await admin.post(`/leads/${ld.id}/move`, { stageId: st(lead, 'Contacted') });
  if (f === 'Arthur') await admin.post(`/leads/${ld.id}/move`, { stageId: st(lead, 'Qualified') });
  if (f === 'Ellen') await admin.post('/activities', { kind: 'call', subject: 'Qualify Ellen’s requirements', dueAt: new Date(Date.now() + 3 * 3600e3).toISOString(), links: [{ entityType: 'lead', entityId: ld.id }] });
}

for (let n = 0; n < 5; n++) { await processOutbox(); await processJobs(100); }
await app.close();
await pool.end();
console.log(`Seeded demo workspace. Sign in as ${EMAIL} / ${PASSWORD} (teammates: dara@, mia@, omar@example.com, same password).`);
