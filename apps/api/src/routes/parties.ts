import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import {
  companyCreateSchema, companyUpdateSchema, contactCreateSchema, contactUpdateSchema, listQuerySchema, personName,
} from '@crm/shared';
import { pool, q, q1, raw, sql, tx, type Db, type Fragment } from '../db/index.ts';
import type { Ctx } from '../lib/context.ts';
import { AppError, badRequest } from '../lib/errors.ts';
import { audit, diff } from '../lib/audit.ts';
import { findDuplicates, loadMethods, replaceMethods } from '../lib/contactMethods.ts';
import { loadDefs, mergeCustom, assertRequired } from '../lib/customFields.ts';
import { ctxOf } from '../lib/http.ts';
import { likeTerm, qs, runList, type ListSpec } from '../lib/list.ts';
import { assertOnRecord, pipelineAllowed, requireAny, scopeWhere } from '../lib/permissions.ts';
import { assertMembers, assertRefs, camel, camelAll, getActive, insertRow, pickColumns, updateRow } from '../lib/records.ts';
import { parse } from '../lib/validate.ts';
import { assertCanChange, assertCreateFields, changedCustomKeys, fieldRule, fieldsFromChanges } from '../lib/fieldAccess.ts';
import { exportCsv } from '../lib/exportList.ts';
import { mergedOr404 } from './merge.ts';

type IdParams = { Params: { id: string } };

const CONTACT_COLS: Record<string, string> = {
  firstName: 'first_name', lastName: 'last_name', jobTitle: 'job_title', birthday: 'birthday', typeId: 'type_id',
  sourceId: 'source_id', primaryCompanyId: 'primary_company_id', address: 'address', description: 'description',
  ownerId: 'owner_id', visibility: 'visibility',
};
const COMPANY_COLS: Record<string, string> = {
  name: 'name', typeId: 'type_id', industryId: 'industry_id', sizeId: 'size_id', sourceId: 'source_id',
  annualRevenue: 'annual_revenue', currency: 'currency', address: 'address', description: 'description',
  ownerId: 'owner_id', visibility: 'visibility',
};

const primaryMethod = (party: string, alias: string, kind: string) =>
  sql`(SELECT value FROM contact_methods cm WHERE cm.party_type = ${party} AND cm.party_id = ${raw(`${alias}.id`)} AND cm.kind = ${kind} ORDER BY is_primary DESC, sort LIMIT 1)`;

async function setContactCompanies(db: Parameters<typeof q>[1], contactId: number, companyIds: number[] | undefined, primary: number | null | undefined) {
  if (companyIds === undefined && primary === undefined) return;
  const ids = new Set(companyIds ?? []);
  if (primary) ids.add(primary);
  if (companyIds !== undefined) await q(sql`DELETE FROM contact_companies WHERE contact_id = ${contactId}`, db);
  for (const id of ids) {
    await q(sql`INSERT INTO contact_companies (contact_id, company_id) VALUES (${contactId}, ${id}) ON CONFLICT DO NOTHING`, db);
  }
}

type PartyRow = Record<string, unknown> & { id: number; owner_id: number; visibility: string; custom: Record<string, unknown> };
export type ContactCreateInput = z.output<typeof contactCreateSchema>;
export type ContactUpdateInput = z.output<typeof contactUpdateSchema>;
export type CompanyCreateInput = z.output<typeof companyCreateSchema>;
export type CompanyUpdateInput = z.output<typeof companyUpdateSchema>;
/** Extra keys stored with the audit event (e.g. `{ _import: { id, file } }` when a record comes from a CSV import). */
type AuditExtra = Record<string, unknown>;

export async function createContact(db: Db, ctx: Ctx, body: ContactCreateInput, extra: AuditExtra = {}): Promise<PartyRow> {
  requireAny(ctx, 'contact', 'create');
  await assertRefs(ctx, [
    { table: 'companies', ids: [body.primaryCompanyId, ...(body.companyIds ?? [])], label: 'Company' },
    { table: 'dictionary_items', ids: [body.typeId], label: 'Contact type', kind: 'contact_type' },
    { table: 'dictionary_items', ids: [body.sourceId], label: 'Source', kind: 'lead_source' },
  ], db);
  await assertMembers(ctx, [body.ownerId], db);
  {
    const { methods: _m, companyIds, ...fields } = body;
    assertCreateFields(ctx, 'contact', { ...fields, primaryCompanyId: fields.primaryCompanyId ?? companyIds?.[0] }, { ownerId: ctx.userId, visibility: 'shared' });
  }
  const defs = await loadDefs(ctx.workspaceId, 'contact', db);
  const custom = mergeCustom(defs, body.custom);
  await assertRequired(defs, custom, undefined, db);
  const primaryCompany = body.primaryCompanyId ?? body.companyIds?.[0] ?? null;
  const row = await insertRow(db, 'contacts', {
    ...pickColumns(body, CONTACT_COLS), primary_company_id: primaryCompany, workspace_id: ctx.workspaceId,
    owner_id: body.ownerId ?? ctx.userId, custom, created_by: ctx.userId, updated_by: ctx.userId,
  }) as PartyRow;
  await replaceMethods(db, ctx.workspaceId, 'contact', row.id, body.methods);
  await setContactCompanies(db, row.id, body.companyIds ?? (primaryCompany ? [primaryCompany] : []), primaryCompany);
  await audit(db, ctx, 'contact', row.id, 'created', { name: personName(body.firstName, body.lastName), ...extra });
  return row;
}

export async function updateContact(db: Db, ctx: Ctx, id: number, body: ContactUpdateInput, extra: AuditExtra = {}): Promise<PartyRow> {
  const before = await getActive<PartyRow>(db, 'contacts', id, ctx, 'Contact');
  assertOnRecord(ctx, 'contact', 'edit', before);
  await assertRefs(ctx, [
    { table: 'companies', ids: [body.primaryCompanyId, ...(body.companyIds ?? [])], label: 'Company' },
    { table: 'dictionary_items', ids: [body.typeId, body.sourceId], label: 'Option' },
  ], db);
  await assertMembers(ctx, [body.ownerId], db);
  const values = pickColumns(body, CONTACT_COLS);
  if (body.custom !== undefined) {
    const defs = await loadDefs(ctx.workspaceId, 'contact', db);
    values.custom = mergeCustom(defs, body.custom, before.custom);
    await assertRequired(defs, values.custom as Record<string, unknown>, undefined, db);
  }
  const lockedC = fieldsFromChanges(diff(before, values), CONTACT_COLS);
  if (values.custom) lockedC.push(...changedCustomKeys(before.custom, values.custom as Record<string, unknown>));
  if (body.companyIds !== undefined && fieldRule(ctx, 'contact', 'primaryCompanyId')) {
    const cur = await q<{ company_id: number }>(sql`SELECT company_id FROM contact_companies WHERE contact_id = ${id}`, db);
    if (JSON.stringify(cur.map((c) => Number(c.company_id)).sort()) !== JSON.stringify([...new Set(body.companyIds)].sort())) lockedC.push('primaryCompanyId');
  }
  assertCanChange(ctx, 'contact', lockedC);
  const merged = { ...before, ...values };
  if (!merged.first_name && !merged.last_name) throw badRequest('Enter a first or last name', { firstName: 'Required' });
  const changes: Record<string, unknown> = diff(before, values);
  const row = await updateRow(db, 'contacts', id, ctx.workspaceId, { ...values, updated_by: ctx.userId }, { version: body.version }) as PartyRow;
  await replaceMethods(db, ctx.workspaceId, 'contact', id, body.methods);
  await setContactCompanies(db, id, body.companyIds, body.primaryCompanyId);
  if (body.methods) changes.methods = [null, body.methods.map((m) => m.value)];
  if (Object.keys(changes).length) await audit(db, ctx, 'contact', id, 'updated', { ...changes, ...extra });
  return row;
}

export async function createCompany(db: Db, ctx: Ctx, body: CompanyCreateInput, extra: AuditExtra = {}): Promise<PartyRow> {
  requireAny(ctx, 'company', 'create');
  await assertRefs(ctx, [{ table: 'dictionary_items', ids: [body.typeId, body.industryId, body.sizeId, body.sourceId], label: 'Option' }], db);
  await assertMembers(ctx, [body.ownerId], db);
  {
    const { methods: _m, ...fields } = body;
    assertCreateFields(ctx, 'company', fields, { ownerId: ctx.userId, visibility: 'shared', currency: ctx.baseCurrency });
  }
  const defs = await loadDefs(ctx.workspaceId, 'company', db);
  const custom = mergeCustom(defs, body.custom);
  await assertRequired(defs, custom, undefined, db);
  const row = await insertRow(db, 'companies', {
    ...pickColumns(body, COMPANY_COLS), currency: body.currency ?? ctx.baseCurrency, workspace_id: ctx.workspaceId,
    owner_id: body.ownerId ?? ctx.userId, custom, created_by: ctx.userId, updated_by: ctx.userId,
  }) as PartyRow;
  await replaceMethods(db, ctx.workspaceId, 'company', row.id, body.methods);
  await audit(db, ctx, 'company', row.id, 'created', { name: body.name, ...extra });
  return row;
}

export async function updateCompany(db: Db, ctx: Ctx, id: number, body: CompanyUpdateInput, extra: AuditExtra = {}): Promise<PartyRow> {
  const before = await getActive<PartyRow>(db, 'companies', id, ctx, 'Company');
  assertOnRecord(ctx, 'company', 'edit', before);
  await assertRefs(ctx, [{ table: 'dictionary_items', ids: [body.typeId, body.industryId, body.sizeId, body.sourceId], label: 'Option' }], db);
  await assertMembers(ctx, [body.ownerId], db);
  const values = pickColumns(body, COMPANY_COLS);
  if (body.custom !== undefined) {
    const defs = await loadDefs(ctx.workspaceId, 'company', db);
    values.custom = mergeCustom(defs, body.custom, before.custom);
    await assertRequired(defs, values.custom as Record<string, unknown>, undefined, db);
  }
  const changes: Record<string, unknown> = diff(before, values);
  const lockedCo = fieldsFromChanges(changes, COMPANY_COLS);
  if (values.custom) lockedCo.push(...changedCustomKeys(before.custom, values.custom as Record<string, unknown>));
  assertCanChange(ctx, 'company', lockedCo);
  const row = await updateRow(db, 'companies', id, ctx.workspaceId, { ...values, updated_by: ctx.userId }, { version: body.version }) as PartyRow;
  await replaceMethods(db, ctx.workspaceId, 'company', id, body.methods);
  if (body.methods) changes.methods = [null, body.methods.map((m) => m.value)];
  if (Object.keys(changes).length) await audit(db, ctx, 'company', id, 'updated', { ...changes, ...extra });
  return row;
}

/** Inline on contact/company pages: the 10 newest deals the user may see, and how many there are (the deals list pages the rest). */
export const RELATED_DEALS_INLINE = 10;
async function relatedDeals(ctx: Ctx, link: Fragment) {
  const where = sql`d.workspace_id = ${ctx.workspaceId} AND d.deleted_at IS NULL AND ${scopeWhere(ctx, 'deal', 'view', 'd')} AND ${link}`;
  const [rows, total] = await Promise.all([
    q(sql`SELECT d.id, d.title, d.amount, d.currency, d.status, s.name AS stage_name, s.color AS stage_color FROM deals d
      JOIN stages s ON s.id = d.stage_id WHERE ${where} ORDER BY d.created_at DESC, d.id DESC LIMIT ${RELATED_DEALS_INLINE}`),
    q1<{ n: number }>(sql`SELECT count(*)::int AS n FROM deals d WHERE ${where}`),
  ]);
  return { deals: camelAll(rows), dealsTotal: total?.n ?? 0 };
}

export async function partyRoutes(app: FastifyInstance) {
  // ─────────────── Contacts ───────────────
  app.get('/contacts', async (req, reply) => {
    const ctx = ctxOf(req);
    requireAny(ctx, 'contact', 'view');
    const query = parse(listQuerySchema, req.query);
    const owner = query.ownerId === 'me' ? ctx.userId : qs.id(query.ownerId);
    const spec: ListSpec = {
      select: sql`c.id, c.first_name, c.last_name, c.job_title, c.type_id, c.owner_id, c.created_at, c.updated_at,
        c.primary_company_id, co.name AS company_name, u.name AS owner_name,
        ${primaryMethod('contact', 'c', 'email')} AS email, ${primaryMethod('contact', 'c', 'phone')} AS phone`,
      from: sql`contacts c LEFT JOIN companies co ON co.id = c.primary_company_id LEFT JOIN users u ON u.id = c.owner_id`,
      where: [
        sql`c.workspace_id = ${ctx.workspaceId}`, sql`c.deleted_at IS NULL`, scopeWhere(ctx, 'contact', 'view', 'c'),
        owner ? sql`c.owner_id = ${owner}` : null,
        qs.id(query.typeId) ? sql`c.type_id = ${qs.id(query.typeId)}` : null,
        qs.id(query.companyId) ? sql`EXISTS (SELECT 1 FROM contact_companies cc WHERE cc.contact_id = c.id AND cc.company_id = ${qs.id(query.companyId)})` : null,
        qs.date(query.createdFrom) ? sql`c.created_at >= ${qs.date(query.createdFrom)}::date` : null,
        qs.date(query.createdTo) ? sql`c.created_at < ${qs.date(query.createdTo)}::date + 1` : null,
      ],
      search: (t) => sql`(
        (coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')) ILIKE ${likeTerm(t)}
        OR co.name ILIKE ${likeTerm(t)}
        OR EXISTS (SELECT 1 FROM contact_methods cm WHERE cm.party_type = 'contact' AND cm.party_id = c.id
                   AND (cm.normalized ILIKE ${likeTerm(t.toLowerCase())} OR cm.value ILIKE ${likeTerm(t)})))`,
      sorts: { name: "lower(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,''))", lastName: 'lower(c.last_name)', company: 'lower(co.name)', owner: 'u.name', createdAt: 'c.created_at', updatedAt: 'c.updated_at' },
      defaultSort: '-createdAt',
    };
    if (query.format === 'csv') {
      return exportCsv(reply, ctx, 'contact', spec, query, 'c', [['ID', 'id'], ['First name', 'first_name'], ['Last name', 'last_name'],
        ['Job title', 'job_title'], ['Company', 'company_name'], ['Email', 'email'], ['Phone', 'phone'], ['Owner', 'owner_name'],
        ['Created', 'created_at'], ['Updated', 'updated_at']], 'contacts');
    }
    const r = await runList(spec, query);
    return { ...r, data: camelAll(r.data as Record<string, unknown>[]) };
  });

  app.get<IdParams>('/contacts/:id', async (req) => {
    const ctx = ctxOf(req);
    const row = await getActive<Record<string, unknown> & { owner_id: number; visibility: string }>(pool, 'contacts', Number(req.params.id), ctx, 'Contact')
      .catch((e) => (e instanceof AppError && e.status === 404 ? mergedOr404(ctx, 'contact', Number(req.params.id)) : Promise.reject(e)));
    assertOnRecord(ctx, 'contact', 'view', row);
    const id = Number(req.params.id);
    const [methods, companies, deals, owner] = await Promise.all([
      loadMethods('contact', [id]),
      q(sql`SELECT co.id, co.name, cc.role FROM contact_companies cc JOIN companies co ON co.id = cc.company_id
            WHERE cc.contact_id = ${id} AND co.deleted_at IS NULL ORDER BY co.name`),
      relatedDeals(ctx, sql`EXISTS (SELECT 1 FROM deal_contacts dc WHERE dc.deal_id = d.id AND dc.contact_id = ${id})`),
      q1(sql`SELECT id, name FROM users WHERE id = ${row.owner_id}`),
    ]);
    return { ...camel(row), methods: camelAll((methods[id] ?? []) as unknown as Record<string, unknown>[]), companies: camelAll(companies), ...deals, owner: camel(owner) };
  });

  app.post('/contacts', async (req, reply) => {
    const ctx = ctxOf(req);
    requireAny(ctx, 'contact', 'create');
    const body = parse(contactCreateSchema, req.body);
    return reply.code(201).send(camel(await tx((db) => createContact(db, ctx, body))));
  });

  app.patch<IdParams>('/contacts/:id', async (req) => {
    const ctx = ctxOf(req);
    const body = parse(contactUpdateSchema, req.body);
    return camel(await tx((db) => updateContact(db, ctx, Number(req.params.id), body)));
  });

  // ─────────────── Companies ───────────────
  app.get('/companies', async (req, reply) => {
    const ctx = ctxOf(req);
    requireAny(ctx, 'company', 'view');
    const query = parse(listQuerySchema, req.query);
    const owner = query.ownerId === 'me' ? ctx.userId : qs.id(query.ownerId);
    const spec: ListSpec = {
      select: sql`co.id, co.name, co.type_id, co.industry_id, co.size_id, co.owner_id, co.created_at, co.updated_at, u.name AS owner_name,
        ${primaryMethod('company', 'co', 'email')} AS email, ${primaryMethod('company', 'co', 'phone')} AS phone,
        ${primaryMethod('company', 'co', 'website')} AS website,
        (SELECT count(*)::int FROM contact_companies cc JOIN contacts c ON c.id = cc.contact_id AND c.deleted_at IS NULL WHERE cc.company_id = co.id) AS contacts_count,
        (SELECT count(*)::int FROM deals d WHERE d.company_id = co.id AND d.deleted_at IS NULL AND d.status = 'open' AND ${pipelineAllowed(ctx, 'd')}) AS open_deals_count`,
      from: sql`companies co LEFT JOIN users u ON u.id = co.owner_id`,
      where: [
        sql`co.workspace_id = ${ctx.workspaceId}`, sql`co.deleted_at IS NULL`, scopeWhere(ctx, 'company', 'view', 'co'),
        owner ? sql`co.owner_id = ${owner}` : null,
        qs.id(query.typeId) ? sql`co.type_id = ${qs.id(query.typeId)}` : null,
        qs.id(query.industryId) ? sql`co.industry_id = ${qs.id(query.industryId)}` : null,
      ],
      search: (t) => sql`(co.name ILIKE ${likeTerm(t)} OR EXISTS (SELECT 1 FROM contact_methods cm WHERE cm.party_type = 'company'
        AND cm.party_id = co.id AND (cm.normalized ILIKE ${likeTerm(t.toLowerCase())} OR cm.value ILIKE ${likeTerm(t)})))`,
      sorts: { name: 'lower(co.name)', owner: 'u.name', createdAt: 'co.created_at', updatedAt: 'co.updated_at' },
      defaultSort: '-createdAt',
    };
    if (query.format === 'csv') {
      return exportCsv(reply, ctx, 'company', spec, query, 'co', [['ID', 'id'], ['Name', 'name'], ['Email', 'email'], ['Phone', 'phone'],
        ['Website', 'website'], ['Contacts', 'contacts_count'], ['Open deals', 'open_deals_count'], ['Owner', 'owner_name'],
        ['Created', 'created_at'], ['Updated', 'updated_at']], 'companies');
    }
    const r = await runList(spec, query);
    return { ...r, data: camelAll(r.data as Record<string, unknown>[]) };
  });

  app.get<IdParams>('/companies/:id', async (req) => {
    const ctx = ctxOf(req);
    const id = Number(req.params.id);
    const row = await getActive<Record<string, unknown> & { owner_id: number; visibility: string }>(pool, 'companies', id, ctx, 'Company')
      .catch((e) => (e instanceof AppError && e.status === 404 ? mergedOr404(ctx, 'company', id) : Promise.reject(e)));
    assertOnRecord(ctx, 'company', 'view', row);
    const [methods, contacts, deals, owner] = await Promise.all([
      loadMethods('company', [id]),
      q(sql`SELECT c.id, c.first_name, c.last_name, c.job_title FROM contact_companies cc JOIN contacts c ON c.id = cc.contact_id
            WHERE cc.company_id = ${id} AND c.deleted_at IS NULL ORDER BY c.first_name, c.last_name`),
      relatedDeals(ctx, sql`d.company_id = ${id}`),
      q1(sql`SELECT id, name FROM users WHERE id = ${row.owner_id}`),
    ]);
    return { ...camel(row), methods: camelAll((methods[id] ?? []) as unknown as Record<string, unknown>[]), contacts: camelAll(contacts), ...deals, owner: camel(owner) };
  });

  app.post('/companies', async (req, reply) => {
    const ctx = ctxOf(req);
    requireAny(ctx, 'company', 'create');
    const body = parse(companyCreateSchema, req.body);
    return reply.code(201).send(camel(await tx((db) => createCompany(db, ctx, body))));
  });

  app.patch<IdParams>('/companies/:id', async (req) => {
    const ctx = ctxOf(req);
    const body = parse(companyUpdateSchema, req.body);
    return camel(await tx((db) => updateCompany(db, ctx, Number(req.params.id), body)));
  });

  // ─────────────── Duplicates ───────────────
  app.get('/duplicates', async (req) => {
    const ctx = ctxOf(req);
    const query = req.query as Record<string, string | undefined>;
    const split = (v?: string) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
    const exclude = query.excludeType && query.excludeId ? { entityType: query.excludeType, id: Number(query.excludeId) } : undefined;
    const hits = await findDuplicates(ctx.workspaceId, { emails: split(query.email), phones: split(query.phone), websites: split(query.website), name: query.name, companyName: query.companyName }, exclude);
    return { data: hits };
  });

}
