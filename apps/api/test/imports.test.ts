import { afterAll, describe, expect, it } from 'vitest';
import { processJobs, processOutbox } from '../src/automation/engine.ts';
import { q, sql } from '../src/db/index.ts';
import { pool } from '../src/db/pool.ts';
import { getApp, inviteUser, signup, type Client } from './helpers.ts';

afterAll(async () => { await (await getApp()).close(); await pool.end(); });

/** Run queued jobs (import chunks, automation) until nothing is left. */
async function drain() {
  for (let n = 0; n < 100; n++) {
    const done = (await processJobs(50)) + (await processOutbox());
    if (!done) return;
  }
}

const upload = (c: Client, entityType: string, content: string, fileName = 'people.csv') =>
  c.post('/imports', { entityType, fileName, content });

async function importAll(c: Client, entityType: string, content: string, options: Record<string, unknown> = {}, mapping?: (string | null)[]) {
  const up = await upload(c, entityType, content);
  expect(up.status, JSON.stringify(up.body)).toBe(201);
  const cfg = { mapping: mapping ?? up.body.mapping, options: { ...up.body.options, ...options } };
  const pv = await c.post(`/imports/${up.body.id}/preview`, cfg);
  expect(pv.status, JSON.stringify(pv.body)).toBe(200);
  const run = await c.post(`/imports/${up.body.id}/run`, cfg);
  expect(run.status, JSON.stringify(run.body)).toBe(200);
  expect(run.body.status).toBe('queued');
  await drain();
  const report = (await c.get(`/imports/${up.body.id}`)).body;
  return { id: up.body.id as number, upload: up.body, preview: pv.body, report };
}

const contactByEmail = async (c: Client, email: string) => {
  const hit = (await c.get(`/contacts?q=${encodeURIComponent(email)}`)).body.data;
  return hit.length === 1 ? (await c.get(`/contacts/${hit[0].id}`)).body : hit;
};

describe('CSV import — contacts', () => {
  it('uploads, suggests a mapping, previews, imports, links companies and reports row errors', async () => {
    const { c, email: adminEmail, dict } = await signup();
    const field = (await c.post('/fields', { entityType: 'contact', label: 'Segment', type: 'select', options: [{ id: 'smb', label: 'SMB' }, { id: 'ent', label: 'Enterprise' }] })).body;
    const acme = (await c.post('/companies', { name: 'Acme Robotics' })).body;
    const csv = [
      'Name,Email,Work phone,Company,Type,Birthday,Segment,Owner,City',
      `"Lovelace, Ada",ada@example.com,+1 555 0100,acme robotics,Customer,1815-12-10,Enterprise,${adminEmail},London`,
      'Grace Hopper,grace@example.com; grace@navy.example.com,,Navy Labs,,,SMB,,Arlington',
      'Bad Email,not-an-email,,,,,,,',
      '',
      'Unknown Type,ut@example.com,,,Alien,,,,',
    ].join('\r\n');

    const up = await upload(c, 'contact', csv);
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({ status: 'draft', rowCount: 4, fileName: 'people.csv' });
    expect(up.body.mapping).toEqual(['fullName', 'email', 'phone', 'company', 'type', 'birthday', `custom.${field.key}`, 'owner', 'city']);
    expect(up.body.sample).toHaveLength(4);
    expect(up.body.options).toMatchObject({ duplicateMode: 'skip', matchBy: ['email'], createCompanies: true });

    const cfg = { mapping: up.body.mapping, options: up.body.options };
    const pv = (await c.post(`/imports/${up.body.id}/preview`, cfg)).body;
    expect(pv.summary).toEqual({ create: 2, update: 0, skip: 0, error: 2, newCompanies: 1 });
    expect(pv.problems.map((p: any) => [p.row, p.message])).toEqual([
      [4, 'Email: Invalid email address ("not-an-email")'],
      [6, 'Contact type: "Alien" is not in the list. Add it in Settings → Lists, or don\'t import this column'],
    ]);
    // Preview writes nothing.
    expect((await c.get('/contacts')).body.total).toBe(0);

    expect((await c.post(`/imports/${up.body.id}/run`, cfg)).status).toBe(200);
    await drain();
    const report = (await c.get(`/imports/${up.body.id}`)).body;
    expect(report).toMatchObject({ status: 'done', processed: 4, created: 2, updated: 0, skipped: 0, failed: 2, issuesTotal: 2 });
    expect(report.issues[0]).toMatchObject({ row: 4, action: 'failed', values: ['Bad Email', 'not-an-email', '', '', '', '', '', '', ''] });

    const ada = await contactByEmail(c, 'ada@example.com');
    expect(ada).toMatchObject({ firstName: 'Ada', lastName: 'Lovelace', birthday: '1815-12-10', primaryCompanyId: acme.id,
      typeId: dict('contact_type').find((d: any) => d.label === 'Customer').id, custom: { [field.key]: 'ent' }, address: { city: 'London' } });
    expect(ada.methods.map((m: any) => [m.kind, m.label, m.value])).toEqual([['email', 'work', 'ada@example.com'], ['phone', 'work', '+1 555 0100']]);
    const grace = await contactByEmail(c, 'grace@example.com');
    expect(grace.methods.filter((m: any) => m.kind === 'email')).toHaveLength(2);
    expect(grace.companies.map((x: any) => x.name)).toEqual(['Navy Labs']);
    expect((await c.get('/companies')).body.total).toBe(2);

    // Audit: each record says it came from this import; the import itself is audited.
    const hist = (await c.get(`/history/contact/${ada.id}`)).body.data;
    expect(hist.find((h: any) => h.action === 'created').changes._import).toEqual({ id: up.body.id, file: 'people.csv' });
    const ev = await q(sql`SELECT action, changes FROM audit_events WHERE entity_type = 'import' AND entity_id = ${up.body.id}`);
    expect(ev).toEqual([{ action: 'imported', changes: { file: 'people.csv', entity: 'contact', created_count: 2, updated_count: 0, skipped_count: 0, failed_count: 2 } }]);

    // Failed rows download: original columns + reason, UTF-8 BOM, ready to re-import.
    const csvRes = await c.raw('GET', `/imports/${up.body.id}/errors.csv`, { headers: { 'x-requested-with': 'crm' } });
    expect(csvRes.status).toBe(200);
    const text = String(csvRes.body);
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text).toContain('Name,Email,Work phone,Company,Type,Birthday,Segment,Owner,City,Import error');
    expect(text.split('\r\n').filter(Boolean)).toHaveLength(3);
  });

  it('handles duplicates: skip, update (merging contact details) and create — including duplicates inside the file', async () => {
    const csv = 'First name,Last name,Email,Phone,Job title\nNew,Name,DUP@example.com,+1 555 0200,CTO\nIn,File,infile@example.com,,A\nIn,File,infile@example.com,,B\n';
    const seed = async (c: Client) => (await c.post('/contacts', { firstName: 'Old', lastName: 'Name', jobTitle: 'Old', methods: [{ kind: 'email', value: 'dup@example.com' }, { kind: 'phone', value: '+1 555 0199' }] })).body;

    // skip (default)
    {
      const { c } = await signup();
      const old = await seed(c);
      const r = await importAll(c, 'contact', csv);
      expect(r.preview.summary).toMatchObject({ create: 1, skip: 2, error: 0 });
      expect(r.preview.rows.map((x: any) => x.message ?? null)).toEqual([`Already exists as contact #${old.id}`, null, 'Already exists as the contact from row 3']);
      expect(r.report).toMatchObject({ created: 1, skipped: 2, updated: 0 });
      expect((await c.get(`/contacts/${old.id}`)).body.jobTitle).toBe('Old');
    }
    // update
    {
      const { c } = await signup();
      const old = await seed(c);
      const r = await importAll(c, 'contact', csv, { duplicateMode: 'update' });
      expect(r.preview.summary).toMatchObject({ create: 1, update: 2 });
      expect(r.report).toMatchObject({ created: 1, updated: 2, skipped: 0, failed: 0 });
      const after = (await c.get(`/contacts/${old.id}`)).body;
      expect(after).toMatchObject({ firstName: 'New', lastName: 'Name', jobTitle: 'CTO' });
      expect(after.methods.map((m: any) => m.value).sort()).toEqual(['+1 555 0199', '+1 555 0200', 'dup@example.com']);
      const upd = (await c.get(`/history/contact/${old.id}`)).body.data.find((h: any) => h.action === 'updated');
      expect(upd.changes.job_title).toEqual(['Old', 'CTO']);
      expect(upd.changes._import.id).toBe(r.id);
      expect((await contactByEmail(c, 'infile@example.com')).jobTitle).toBe('B');
      expect((await c.get('/contacts')).body.total).toBe(2);
    }
    // create anyway
    {
      const { c } = await signup();
      await seed(c);
      const r = await importAll(c, 'contact', csv, { duplicateMode: 'create' });
      expect(r.report).toMatchObject({ created: 3 });
      expect((await c.get('/contacts')).body.total).toBe(4);
    }
    // ambiguous match: two existing records share the email
    {
      const { c } = await signup();
      await seed(c);
      await seed(c);
      const r = await importAll(c, 'contact', 'Name,Email\nX Y,dup@example.com\n', { duplicateMode: 'update' });
      expect(r.report.failed).toBe(1);
      expect(r.report.issues[0].message).toMatch(/^Matches 2 existing records/);
    }
  });

  it('matches by phone or name when chosen, parses day-first dates, and enforces required custom fields', async () => {
    const { c } = await signup();
    await c.post('/fields', { entityType: 'contact', label: 'Region code', type: 'text', required: 'always' });
    const existing = (await c.post('/contacts', { firstName: 'Phone', lastName: 'Match', custom: { region_code: 'EU' }, methods: [{ kind: 'phone', value: '+44 20 7946 0000' }] })).body;
    const csv = 'Full name,Mobile,Birthday,Region code\nPhone Match Again,+44 (20) 7946-0000,31/12/1990,EU\nNo Region,,01/02/2000,\nBad Date,,31/02/2000,EU\n';
    const r = await importAll(c, 'contact', csv, { matchBy: ['phone'], duplicateMode: 'update', dateFormat: 'dmy' });
    expect(r.report).toMatchObject({ updated: 1, created: 0, failed: 2 });
    expect(r.report.issues.map((i: any) => i.message)).toEqual(['Please fill in: Region code', 'Birthday: "31/02/2000" is not a date (expected DD/MM/YYYY)']);
    const after = (await c.get(`/contacts/${existing.id}`)).body;
    expect(after).toMatchObject({ firstName: 'Phone Match', lastName: 'Again', birthday: '1990-12-31' });
    expect(after.methods.find((m: any) => m.kind === 'phone' && m.label === 'mobile')).toBeUndefined(); // same number → not added twice

    const byName = await importAll(c, 'contact', 'First name,Last name\nphone match ,AGAIN\n', { matchBy: ['name'] });
    expect(byName.report).toMatchObject({ skipped: 1, created: 0 });
  });
});

describe('CSV import — companies and leads', () => {
  it('imports companies with dictionaries, money and currency', async () => {
    const { c, dict } = await signup();
    await c.post('/companies', { name: 'Initech' });
    const csv = 'Company,Website,Industry,Size,Annual revenue,Currency\nGlobex,https://globex.example.com,technology,51–200,"1,500,000.50",eur\nInitech,initech.example.com,Retail,,,\nUmbrella,,,,abc,USD\n';
    const r = await importAll(c, 'company', csv);
    expect(r.upload.mapping).toEqual(['name', 'website', 'industry', 'size', 'annualRevenue', 'currency']);
    expect(r.report).toMatchObject({ created: 1, skipped: 1, failed: 1 });
    expect(r.report.issues.find((i: any) => i.action === 'failed').message).toBe('Annual revenue: "abc" is not an amount');
    const globex = (await c.get('/companies?q=globex')).body.data[0];
    const full = (await c.get(`/companies/${globex.id}`)).body;
    expect(full).toMatchObject({ annualRevenue: '1500000.50', currency: 'EUR', industryId: dict('industry').find((d: any) => d.label === 'Technology').id });
    expect(full.methods[0]).toMatchObject({ kind: 'website', value: 'https://globex.example.com' });
  });

  it('imports leads into stages, without running automation unless asked to', async () => {
    const { c, leadPipeline, stage } = await signup();
    await c.post('/automation-rules', { entityType: 'lead', pipelineId: leadPipeline.id, trigger: 'created', action: 'add_note', config: { text: 'Welcome {{title}}' } });
    const csv = 'Title,Name,Email,Status,Value,Source\nWebsite form,Ada L,ada@x.example.com,contacted,2500,Website\nBad stage,Bob B,bob@x.example.com,Converted,,\n,Cy C,cy@x.example.com,,,\n';
    const r = await importAll(c, 'lead', csv);
    expect(r.upload.mapping).toEqual(['title', 'fullName', 'email', 'stage', 'amount', 'source']);
    expect(r.report).toMatchObject({ created: 2, failed: 1 });
    expect(r.report.issues[0].message).toBe('Stage: leads can\'t be imported into the "Converted" stage; use an open stage');
    const leads = (await c.get('/leads?sort=title')).body.data;
    expect(leads.map((l: any) => [l.title, l.stageName, l.amount])).toEqual([['Cy C', 'New', null], ['Website form', 'Contacted', '2500.00']]);
    expect(leads[1].stageId).toBe(stage(leadPipeline, 'Contacted').id);
    await drain();
    const notes = async (id: number) => (await c.get(`/timeline/lead/${id}`)).body.items.filter((i: any) => i.type === 'note');
    expect(await notes(leads[0].id)).toHaveLength(0);

    const r2 = await importAll(c, 'lead', 'Title,Email\nAuto lead,auto@x.example.com\n', { runAutomation: true });
    expect(r2.report.created).toBe(1);
    await drain();
    const auto = (await c.get('/leads?q=Auto')).body.data[0];
    expect((await notes(auto.id)).map((n: any) => n.data.body)).toEqual(['Welcome Auto lead']);
  });
});

describe('CSV import — permissions, isolation and limits', () => {
  it('requires the import permission; Managers have it by default, reps only when granted', async () => {
    const { c: admin } = await signup();
    const viewer = await inviteUser(admin, 'Viewer', 'Vic');
    const rep = await inviteUser(admin, 'Sales rep', 'Rita');
    const manager = await inviteUser(admin, 'Manager', 'Max');
    const csv = 'Name\nAlice A\n';
    expect((await upload(viewer.c, 'contact', csv)).status).toBe(403);
    expect((await upload(rep.c, 'contact', csv)).status).toBe(403);
    expect((await upload(manager.c, 'contact', csv)).status).toBe(201);
    expect((await manager.c.get('/auth/me')).body.permissions.contact.import).toBe('all');
    expect((await rep.c.get('/auth/me')).body.permissions.contact.import).toBe('none');

    const roles = (await admin.get('/roles')).body.data;
    const repRole = roles.find((r: any) => r.name === 'Sales rep');
    const grants = { ...repRole.grants, contact: { ...repRole.grants.contact, import: 'all' } };
    expect((await admin.patch(`/roles/${repRole.id}`, { grants })).status).toBe(200);
    const mine = await upload(rep.c, 'contact', csv);
    expect(mine.status).toBe(201);
    expect((await upload(rep.c, 'company', 'Company\nX\n')).status).toBe(403); // granted for contacts only

    // History: reps see their own imports, admins see all.
    expect((await rep.c.get('/imports')).body.data.map((i: any) => i.id)).toEqual([mine.body.id]);
    expect((await admin.get('/imports')).body.data).toHaveLength(2);
    const managersImport = (await admin.get('/imports')).body.data.find((i: any) => i.id !== mine.body.id);
    expect((await rep.c.get(`/imports/${managersImport.id}`)).status).toBe(404);
  });

  it('does not let an import update records the user may not edit', async () => {
    const { c: admin } = await signup();
    const role = (await admin.post('/roles', { name: 'Importer', grants: { contact: { view: 'all', create: 'all', edit: 'own', import: 'all' } } })).body;
    const imp = await inviteUser(admin, 'Importer', 'Ivy');
    const theirs = (await admin.post('/contacts', { firstName: 'Admin', lastName: 'Owned', methods: [{ kind: 'email', value: 'owned@example.com' }] })).body;
    const r = await importAll(imp.c, 'contact', 'Name,Email,Job title\nChanged Name,owned@example.com,Hacker\n', { duplicateMode: 'update' });
    expect(r.preview.summary.error).toBe(1);
    expect(r.report).toMatchObject({ failed: 1, updated: 0 });
    expect(r.report.issues[0].message).toBe(`Matches contact #${theirs.id}, which you are not allowed to edit`);
    expect((await admin.get(`/contacts/${theirs.id}`)).body.firstName).toBe('Admin');
    void role;
  });

  it('keeps imports isolated per workspace', async () => {
    const a = await signup('Alpha');
    const b = await signup('Beta');
    const up = (await upload(a.c, 'contact', 'Name,Email\nSecret Person,secret@example.com\n')).body;
    const cfg = { mapping: up.mapping, options: up.options };
    expect((await b.c.get(`/imports/${up.id}`)).status).toBe(404);
    expect((await b.c.post(`/imports/${up.id}/preview`, cfg)).status).toBe(404);
    expect((await b.c.post(`/imports/${up.id}/run`, cfg)).status).toBe(404);
    expect((await b.c.post(`/imports/${up.id}/cancel`)).status).toBe(404);
    expect((await b.c.post(`/imports/${up.id}/undo`)).status).toBe(404);
    expect((await b.c.raw('GET', `/imports/${up.id}/errors.csv`, { headers: { 'x-requested-with': 'crm' } })).status).toBe(404);
    expect((await b.c.get('/imports')).body.data).toEqual([]);
    // Duplicate matching never looks at another workspace's records.
    await b.c.post('/contacts', { firstName: 'Secret', lastName: 'Person', methods: [{ kind: 'email', value: 'secret@example.com' }] });
    expect((await a.c.post(`/imports/${up.id}/preview`, cfg)).body.summary).toMatchObject({ create: 1, skip: 0 });
  });

  it('validates files, mappings and options', async () => {
    const { c } = await signup();
    expect((await upload(c, 'contact', '')).status).toBe(400);
    expect((await upload(c, 'contact', 'Name,Email\n')).body.error.message).toBe('The file has a header row but no data rows');
    expect((await upload(c, 'contact', 'Name\n"Unclosed\n')).body.error.message).toBe('This file can\'t be read as CSV: A quoted value that starts on line 2 is never closed');
    expect((await upload(c, 'deal', 'Title\nX\n')).status).toBe(400);
    const big = 'Name\n' + Array.from({ length: 10_001 }, (_, i) => `P${i}`).join('\n');
    expect((await upload(c, 'contact', big)).body.error.message).toMatch(/the limit is 10,000/);

    const up = (await upload(c, 'contact', 'Email,Name,Other\na@example.com,A A,x\n')).body;
    const post = (body: unknown) => c.post(`/imports/${up.id}/preview`, body);
    expect((await post({ mapping: ['email'], options: {} })).body.error.message).toBe('The mapping must have one entry per column');
    expect((await post({ mapping: ['email', null, null], options: {} })).body.error.message).toBe('Map a column to First name, Last name or Full name');
    expect((await post({ mapping: ['email', 'fullName', 'fullName'], options: {} })).body.error.message).toBe('"Full name" is mapped to 2 columns; choose one');
    expect((await post({ mapping: ['email', 'fullName', 'custom.nope'], options: {} })).body.error.message).toBe('Unknown custom field "nope"');
    expect((await post({ mapping: ['email', 'fullName', null], options: { duplicateMode: 'update', matchBy: [] } })).body.error.message).toBe('Choose how to recognise existing records');
    expect((await post({ mapping: ['email', 'fullName', null], options: { ownerId: 999999 } })).status).toBe(400);
    const cfg = { mapping: ['email', 'fullName', null], options: { matchBy: ['email'] } };
    expect((await c.post(`/imports/${up.id}/run`, cfg)).status).toBe(200);
    expect((await c.post(`/imports/${up.id}/run`, cfg)).body.error.message).toBe('This import has already been started');
    expect((await post(cfg)).status).toBe(400);
    await drain();
  });
});

describe('CSV import — big files, cancel and undo', () => {
  const people = (n: number, prefix = 'p') => 'First name,Last name,Email\n' + Array.from({ length: n }, (_, i) => `P${i},Bulk,${prefix}${i}@example.com`).join('\n');

  it('processes large files in chunks and can be cancelled between chunks', async () => {
    const { c } = await signup();
    const up = (await upload(c, 'contact', people(450))).body;
    const cfg = { mapping: up.mapping, options: up.options };
    await c.post(`/imports/${up.id}/run`, cfg);
    await processJobs(50); // the queue holds other workspaces' jobs too; run until our first chunk has gone through
    let st = (await c.get(`/imports/${up.id}`)).body;
    for (let n = 0; n < 20 && st.processed === 0; n++) { await processJobs(50); st = (await c.get(`/imports/${up.id}`)).body; }
    expect(st.processed % 200 === 0 || st.processed === 450).toBe(true);
    await drain();
    st = (await c.get(`/imports/${up.id}`)).body;
    expect(st).toMatchObject({ status: 'done', processed: 450, created: 450 });
    expect((await c.get('/contacts')).body.total).toBe(450);
    const results = await q<{ n: number }>(sql`SELECT jsonb_array_length(results) AS n FROM imports WHERE id = ${up.id}`);
    expect(results[0].n).toBe(450);

    const up2 = (await upload(c, 'contact', people(450, 'q'))).body;
    await c.post(`/imports/${up2.id}/run`, { mapping: up2.mapping, options: up2.options });
    const { runChunk } = await import('../src/imports/engine.ts');
    expect(await runChunk(up2.id)).toBe(true); // one chunk, more to come
    const cancelled = await c.post(`/imports/${up2.id}/cancel`);
    expect(cancelled.body).toMatchObject({ status: 'canceled', processed: 200 });
    await drain();
    expect((await c.get(`/imports/${up2.id}`)).body).toMatchObject({ status: 'canceled', processed: 200, created: 200 });
    expect((await c.post(`/imports/${up2.id}/cancel`)).status).toBe(400);
  });

  it('undo moves created records to the recycle bin and leaves updated ones alone', async () => {
    const { c } = await signup();
    const existing = (await c.post('/contacts', { firstName: 'Keep', lastName: 'Me', methods: [{ kind: 'email', value: 'keep@example.com' }] })).body;
    const r = await importAll(c, 'contact', 'Name,Email,Job title\nKeep Me,keep@example.com,Boss\nNew One,new1@example.com,\nNew Two,new2@example.com,\n', { duplicateMode: 'update' });
    expect(r.report).toMatchObject({ created: 2, updated: 1 });
    const undo = await c.post(`/imports/${r.id}/undo`);
    expect(undo.body).toEqual({ deleted: 2, notAllowed: 0, alreadyGone: 0 });
    expect((await c.get('/contacts')).body.total).toBe(1);
    expect((await c.get(`/contacts/${existing.id}`)).body.jobTitle).toBe('Boss');
    const bin = (await c.get('/recycle-bin')).body.data.map((x: any) => x.title).sort();
    expect(bin).toEqual(['New One', 'New Two']);
    expect((await c.get(`/imports/${r.id}`)).body.undoneAt).not.toBeNull();
    expect((await c.post(`/imports/${r.id}/undo`)).body.error.message).toBe('This import was already undone');
  });
});
