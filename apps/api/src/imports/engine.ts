/**
 * CSV import engine.
 *
 *   buildRow()   cells + mapping  → create-shaped input (dictionary labels, owners, dates, numbers, custom fields resolved)
 *   MatchIndex   existing records (and rows already handled in this import) by email / phone / name / website
 *   decide()     create | update | skip | error, following the chosen duplicate mode
 *   preview()    runs the above over the whole file without writing anything
 *   runChunk()   executes up to IMPORT_LIMITS.chunkSize rows in one transaction (a savepoint per row) and queues the next
 *                chunk, so a crash or restart resumes where it stopped and other jobs are not blocked.
 *
 * Records are written through the same functions as the API routes (createContact, updateLead, …), so validation,
 * required fields, permissions and audit are identical to manual entry.
 */
import {
  contactCreateSchema, contactUpdateSchema, companyCreateSchema, companyUpdateSchema, dealCreateSchema, dealUpdateSchema,
  IMPORT_LIMITS, IMPORT_TARGETS, leadCreateSchema, leadUpdateSchema, productCreateSchema, productUpdateSchema, normalizeContactValue, normalizeNumberCell, parseBoolCell,
  parseDateCell, personName, splitFullName, splitListCell,
  calcLine, importPermissionEntity, lineItemSchema,
  type ContactMethodInput, type ImportEntity, type ImportOptions, type MatchKey,
} from '@crm/shared';
import { pool, q, q1, raw, sql, tx, type Db } from '../db/index.ts';
import { audit } from '../lib/audit.ts';
import { ctxForUser } from '../lib/auth.ts';
import { loadMethods } from '../lib/contactMethods.ts';
import type { Ctx } from '../lib/context.ts';
import { assertRequired, loadDefs, mergeCustom, type FieldDef } from '../lib/customFields.ts';
import { AppError } from '../lib/errors.ts';
import { assertOnRecord, canOnRecord, scopeOf, scopeWhere } from '../lib/permissions.ts';
import { parse } from '../lib/validate.ts';
import { createCompany, createContact, updateCompany, updateContact } from '../routes/parties.ts';
import { createLead, updateLead } from '../routes/leads.ts';
import { createDeal, recalcDealAmount, updateDeal } from '../routes/deals.ts';
import { assertCanChange, fieldRule } from '../lib/fieldAccess.ts';
import { createProduct, updateProduct } from '../routes/products.ts';

export interface ImportRow {
  id: number; workspace_id: number; entity_type: ImportEntity; file_name: string; status: string;
  headers: string[]; rows: string[][] | null; row_numbers: number[]; row_count: number;
  mapping: (string | null)[]; options: ImportOptions; processed: number;
  created_count: number; updated_count: number; skipped_count: number; failed_count: number;
  results: RowResult[]; error: string | null; undone_at: Date | null; created_by: number;
  created_at: Date; started_at: Date | null; finished_at: Date | null;
}
export type RowAction = 'created' | 'updated' | 'skipped' | 'failed';
export interface RowResult { i: number; action: RowAction; id?: number; message?: string }

export const TABLE: Record<ImportEntity, string> = { contact: 'contacts', company: 'companies', lead: 'leads', deal: 'deals', product: 'products', deal_line: 'line_items' };
const NOUN: Record<ImportEntity, string> = { contact: 'contact', company: 'company', lead: 'lead', deal: 'deal', product: 'product', deal_line: 'product line' };
/** Records with an owner and visibility (products have neither: their access is the role's product scope). */
const OWNED = (e: ImportEntity) => e !== 'product';

/** A problem with one row; the message is shown in the report. */
class RowError extends Error {}
const fail = (msg: string): never => { throw new RowError(msg); };

// ───────────────────────── Lookups (loaded once per preview / chunk) ─────────────────────────

interface Lookups {
  defs: FieldDef[];
  dict: Map<string, Map<string, number>>;
  users: Map<string, number>;
  stages: Map<string, { id: number; kind: string }>;
  pipelineId: number | null;
  /** Leads/deals: first open stage of the pipeline (where rows without a Stage column land). */
  defaultStageId: number | null;
  /** Products: category name → id. */
  categories: Map<string, number>;
  /** Admin chose "add missing list options": unknown list values are created instead of failing the row. */
  addOptions: boolean;
  /** "Products on deals": deals the user can see and the product catalogue. */
  lines?: LineLookups;
}

async function loadLookups(db: Db, ctx: Ctx, entity: ImportEntity, options: ImportOptions): Promise<Lookups> {
  const defs = await loadDefs(ctx.workspaceId, entity, db);
  const dict = new Map<string, Map<string, number>>();
  for (const d of await q<{ id: number; kind: string; label: string }>(sql`SELECT id, kind, label FROM dictionary_items
      WHERE workspace_id = ${ctx.workspaceId} AND is_active ORDER BY sort, id`, db)) {
    const m = dict.get(d.kind) ?? new Map<string, number>();
    if (!m.has(d.label.toLowerCase())) m.set(d.label.toLowerCase(), d.id);
    dict.set(d.kind, m);
  }
  const users = new Map<string, number>();
  const names = new Map<string, number[]>();
  for (const u of await q<{ id: number; email: string; name: string }>(sql`SELECT u.id, u.email, u.name FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = ${ctx.workspaceId} AND m.status <> 'disabled'`, db)) {
    users.set(u.email.toLowerCase(), u.id);
    names.set(u.name.toLowerCase(), [...(names.get(u.name.toLowerCase()) ?? []), u.id]);
  }
  for (const [n, ids] of names) if (ids.length === 1 && !users.has(n)) users.set(n, ids[0]); // names only when unambiguous
  const stages = new Map<string, { id: number; kind: string }>();
  let pipelineId: number | null = null;
  let defaultStageId: number | null = null;
  if (entity === 'lead' || entity === 'deal') {
    const blocked = ctx.blockedPipelineIds ?? [];
    const p = options.pipelineId
      ? await q1<{ id: number }>(sql`SELECT id FROM pipelines WHERE id = ${options.pipelineId} AND workspace_id = ${ctx.workspaceId} AND entity_type = ${entity}
          AND NOT (id = ANY(${blocked}))`, db)
      : await q1<{ id: number }>(sql`SELECT id FROM pipelines WHERE workspace_id = ${ctx.workspaceId} AND entity_type = ${entity}
          AND NOT (id = ANY(${blocked})) ORDER BY is_default DESC, sort, id LIMIT 1`, db);
    if (!p) throw new AppError(400, 'VALIDATION_FAILED', `${entity === 'lead' ? 'Lead' : 'Deal'} pipeline not found`, { 'options.pipelineId': 'Invalid pipeline' });
    pipelineId = p.id;
    for (const s of await q<{ id: number; name: string; kind: string }>(sql`SELECT id, name, kind FROM stages WHERE pipeline_id = ${p.id} ORDER BY sort, id`, db)) {
      if (!stages.has(s.name.toLowerCase())) stages.set(s.name.toLowerCase(), { id: s.id, kind: s.kind });
      if (s.kind === 'open' && defaultStageId === null) defaultStageId = s.id;
    }
  }
  const categories = new Map<string, number>();
  if (entity === 'product') {
    for (const c of await q<{ id: number; name: string }>(sql`SELECT id, name FROM product_categories WHERE workspace_id = ${ctx.workspaceId}`, db)) {
      categories.set(c.name.toLowerCase(), Number(c.id));
    }
  }
  return { defs, dict, users, stages, pipelineId, defaultStageId, categories, addOptions: options.addMissingOptions && ctx.isAdmin,
    lines: entity === 'deal_line' ? await loadLineLookups(db, ctx) : undefined };
}

// ───────────────────────── Row → input ─────────────────────────

export interface BuiltRow {
  /** Create-shaped input (also the source of update values). */
  input: Record<string, unknown>;
  /** Values used for duplicate matching. */
  keys: Partial<Record<MatchKey, string[]>>;
  /** Contacts: company name to link (created when missing and allowed). */
  companyName?: string;
  /** Record title for the preview and report. */
  title: string;
  /** Deals: contacts to link (email or full name), resolved when the row is written. */
  contactRefs?: string[];
  /** List values to create before the row is written ("add missing list options"). Custom select options: kind
   *  "custom:<key>" with the option id that the row already uses. */
  newOptions?: { field: string; kind: string; label: string; id?: string }[];
}

const DICT_KIND: Record<string, Partial<Record<ImportEntity, string>>> = {
  type: { contact: 'contact_type', company: 'company_type' },
  industry: { company: 'industry' },
  size: { company: 'company_size' },
  source: { contact: 'lead_source', company: 'lead_source', lead: 'lead_source', deal: 'lead_source' },
  dealType: { deal: 'deal_type' },
};
const INPUT_KEY: Record<string, string> = { type: 'typeId', industry: 'industryId', size: 'sizeId', source: 'sourceId', dealType: 'dealTypeId' };
/** Pseudo list kind for product categories (their own table). */
const CATEGORY = '__category';
const ADDRESS_KEYS = ['street', 'city', 'region', 'postalCode', 'country'];

/** Method label from the column header ("Mobile phone" → mobile, "Home email" → home). */
function methodLabel(header: string): string {
  const h = header.toLowerCase();
  if (/mobile|cell/.test(h)) return 'mobile';
  if (/home|personal|private/.test(h)) return 'home';
  return 'work';
}

/** A new option for a custom select field (admin "add missing values"): stable id from the label, unique in the field.
 *  It is added to the in-memory definition so later rows (and the preview's validation) use the same option. */
function addCustomOption(def: FieldDef, label: string, newOptions: NonNullable<BuiltRow['newOptions']>): string {
  const base = label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'option';
  let id = base;
  for (let n = 2; def.options.some((o) => o.id === id); n++) id = `${base}_${n}`;
  def.options = [...def.options, { id, label: label.trim().slice(0, 100) }];
  newOptions.push({ field: '', kind: `custom:${def.key}`, label: label.trim().slice(0, 100), id });
  return id;
}

function customValue(def: FieldDef, raw: string, lk: Lookups, options: ImportOptions, newOptions: NonNullable<BuiltRow['newOptions']> = []): unknown {
  const bad = (m: string): never => fail(`${def.label}: ${m}`);
  switch (def.type) {
    case 'number': { const n = normalizeNumberCell(raw); return n === null ? bad('must be a number') : Number(n); }
    case 'money': return normalizeNumberCell(raw) ?? bad('must be an amount like 1500.00');
    case 'date': return parseDateCell(raw, options.dateFormat) ?? bad(`"${raw}" is not a date (${dateHint(options)})`);
    case 'datetime': {
      if (/\d{1,2}:\d{2}/.test(raw) && !Number.isNaN(Date.parse(raw))) return new Date(raw).toISOString();
      const d = parseDateCell(raw, options.dateFormat);
      return d ? `${d}T00:00:00.000Z` : bad(`"${raw}" is not a date (${dateHint(options)})`);
    }
    case 'boolean': { const b = parseBoolCell(raw); return b === null ? bad('use yes or no') : b; }
    case 'select': return optionId(def, raw) ?? (lk.addOptions ? addCustomOption(def, raw, newOptions) : bad(`"${raw}" is not one of the options (${def.options.map((o) => o.label).slice(0, 8).join(', ')})`));
    case 'multiselect': return splitListCell(raw).map((v) => optionId(def, v) ?? (lk.addOptions ? addCustomOption(def, v, newOptions) : bad(`"${v}" is not one of the options`)));
    case 'user': return lk.users.get(raw.toLowerCase()) ?? bad(`no workspace member called "${raw}"`);
    default: return raw;
  }
}
const optionId = (def: FieldDef, v: string) => def.options.find((o) => o.label.toLowerCase() === v.toLowerCase() || o.id === v)?.id;
const dateHint = (o: ImportOptions) => ({ ymd: 'expected YYYY-MM-DD', dmy: 'expected DD/MM/YYYY', mdy: 'expected MM/DD/YYYY' })[o.dateFormat];

export function buildRow(entity: ImportEntity, headers: string[], cells: string[], mapping: (string | null)[], lk: Lookups, options: ImportOptions): BuiltRow {
  if (entity === 'deal_line') return buildLineRow(cells, mapping, lk.lines!);
  const input: Record<string, unknown> = {};
  const custom: Record<string, unknown> = {};
  const address: Record<string, string> = {};
  const methods: ContactMethodInput[] = [];
  let fullName: string | null = null;
  let companyName: string | undefined;
  const contactRefs: string[] = [];
  const newOptions: NonNullable<BuiltRow['newOptions']> = [];
  const labelOf = (key: string) => IMPORT_TARGETS[entity].find((t) => t.key === key)?.label ?? key;

  mapping.forEach((key, col) => {
    const v = (cells[col] ?? '').trim();
    if (!key || !v) return;
    if (key.startsWith('custom.')) {
      const def = lk.defs.find((d) => d.key === key.slice(7));
      if (def) custom[def.key] = customValue(def, v, lk, options, newOptions);
      return;
    }
    switch (key) {
      case 'email': for (const e of splitListCell(v)) methods.push({ kind: 'email', label: methodLabel(headers[col]), value: e }); break;
      case 'phone': for (const p of v.split(/[;|\n]/).map((x) => x.trim()).filter(Boolean)) methods.push({ kind: 'phone', label: methodLabel(headers[col]), value: p }); break;
      case 'website': for (const w of splitListCell(v)) methods.push({ kind: 'website', label: 'work', value: w }); break;
      case 'fullName': fullName = v; break;
      case 'company': companyName = v; break;
      case 'contact': contactRefs.push(...splitListCell(v)); break;
      case 'owner': input.ownerId = lk.users.get(v.toLowerCase()) ?? fail(`Owner: no workspace member with the name or email "${v}"`); break;
      case 'type': case 'industry': case 'size': case 'source': case 'dealType': {
        const kind = DICT_KIND[key][entity]!;
        const id = lk.dict.get(kind)?.get(v.toLowerCase());
        if (id) input[INPUT_KEY[key]] = id;
        else if (lk.addOptions) newOptions.push({ field: INPUT_KEY[key], kind, label: v });
        else fail(`${labelOf(key)}: "${v}" is not in the list. Add it in Settings → Lists, or don't import this column`);
        break;
      }
      case 'category': {
        const id = lk.categories.get(v.toLowerCase());
        if (id) input.categoryId = id;
        else if (lk.addOptions) newOptions.push({ field: 'categoryId', kind: CATEGORY, label: v });
        else fail(`Category: "${v}" doesn't exist. Add it under Products, or don't import this column`);
        break;
      }
      case 'expectedCloseDate': input.expectedCloseDate = parseDateCell(v, options.dateFormat) ?? fail(`Expected close date: "${v}" is not a date (${dateHint(options)})`); break;
      case 'probability': {
        const n = normalizeNumberCell(v.replace('%', ''));
        input.probability = n !== null && Number(n) >= 0 && Number(n) <= 100 ? Math.round(Number(n)) : fail(`Probability: "${v}" must be a number from 0 to 100`);
        break;
      }
      case 'unitPrice': input.unitPrice = normalizeNumberCell(v) ?? fail(`Price: "${v}" is not an amount`); break;
      case 'taxRate': {
        const n = normalizeNumberCell(v.replace('%', ''));
        input.taxRate = n !== null && Number(n) >= 0 && Number(n) <= 100 ? Number(n) : fail(`Tax %: "${v}" must be a number from 0 to 100`);
        break;
      }
      case 'taxIncluded': case 'isActive': {
        const b = parseBoolCell(v);
        input[key] = b ?? fail(`${labelOf(key)}: use yes or no`);
        break;
      }
      case 'birthday': input.birthday = parseDateCell(v, options.dateFormat) ?? fail(`Birthday: "${v}" is not a date (${dateHint(options)})`); break;
      case 'amount': case 'annualRevenue': input[key] = normalizeNumberCell(v) ?? fail(`${labelOf(key)}: "${v}" is not an amount`); break;
      case 'currency': input.currency = v.toUpperCase(); break;
      case 'stage': {
        const s = lk.stages.get(v.toLowerCase()) ?? fail(`Stage: no stage called "${v}" in the ${entity} pipeline`);
        // Deals may be imported as won or lost (history); leads only into open stages.
        if (entity === 'lead' && s.kind !== 'open') fail(`Stage: leads can't be imported into the "${v}" stage; use an open stage`);
        input.stageId = s.id;
        break;
      }
      default:
        if (ADDRESS_KEYS.includes(key)) address[key] = v;
        else input[key] = v;
    }
  });

  if (fullName && entity !== 'company') {
    const [first, last] = splitFullName(fullName);
    input.firstName ??= first;
    input.lastName ??= last;
  }
  if (methods.length) input.methods = methods;
  if (Object.keys(address).length) input.address = address;
  if (Object.keys(custom).length) input.custom = custom;
  if ((entity === 'lead' || entity === 'deal') && lk.pipelineId) input.pipelineId = lk.pipelineId;

  const keys: BuiltRow['keys'] = {
    email: methods.filter((m) => m.kind === 'email').map((m) => normalizeContactValue('email', m.value)),
    phone: methods.filter((m) => m.kind === 'phone').map((m) => normalizeContactValue('phone', m.value)).filter((p) => p.replace(/\D/g, '').length >= 5),
    website: methods.filter((m) => m.kind === 'website').map((m) => normalizeContactValue('website', m.value)),
  };
  const name = entity === 'company' || entity === 'product' ? String(input.name ?? '')
    : entity === 'deal' ? String(input.title ?? '')
      : personName(input.firstName as string, input.lastName as string);
  if (name) keys.name = [name.toLowerCase().trim().replace(/\s+/g, ' ')];
  if (entity === 'product' && input.sku) keys.sku = [String(input.sku).toLowerCase().trim()];
  const title = entity === 'lead'
    ? String(input.title || input.companyName || name || methods[0]?.value || 'New lead')
    : name || '—';
  return { input, keys, companyName, title, ...(contactRefs.length ? { contactRefs } : {}), ...(newOptions.length ? { newOptions } : {}) };
}

// ───────────────────────── Duplicate matching ─────────────────────────

/** key:value → matching record ids. Rows handled earlier in the same import are added as they are processed. */
export class MatchIndex {
  private readonly map = new Map<string, Set<number | string>>();
  add(key: MatchKey, value: string, id: number | string) {
    const k = `${key}:${value}`;
    const s = this.map.get(k) ?? new Set();
    s.add(id);
    this.map.set(k, s);
  }
  find(keys: BuiltRow['keys'], matchBy: MatchKey[]): (number | string)[] {
    for (const key of matchBy) {
      const ids = new Set<number | string>();
      for (const v of keys[key] ?? []) for (const id of this.map.get(`${key}:${v}`) ?? []) ids.add(id);
      if (ids.size) return [...ids];
    }
    return [];
  }
  addRow(keys: BuiltRow['keys'], id: number | string) {
    for (const [key, values] of Object.entries(keys) as [MatchKey, string[]][]) for (const v of values) this.add(key, v, id);
  }
}

/** Load existing (not deleted) records matching any of the rows' keys. Leads only match open leads. */
async function loadMatches(db: Db, ctx: Ctx, entity: ImportEntity, rows: BuiltRow[], matchBy: MatchKey[]): Promise<MatchIndex> {
  const index = new MatchIndex();
  const table = raw(TABLE[entity]);
  const alive = entity === 'lead' ? sql`t.deleted_at IS NULL AND t.status = 'open'` : sql`t.deleted_at IS NULL`;
  for (const key of matchBy) {
    const values = [...new Set(rows.flatMap((r) => r.keys[key] ?? []))];
    if (!values.length) continue;
    if (entity === 'deal' || entity === 'product') {
      // Deals match by title, products by name or SKU. A user only matches deals they may see.
      const col = key === 'sku' ? raw('t.sku') : raw(entity === 'deal' ? 't.title' : 't.name');
      const found = await q<{ id: number; v: string }>(sql`SELECT t.id, lower(regexp_replace(trim(${col}), '\\s+', ' ', 'g')) AS v FROM ${table} t
        WHERE t.workspace_id = ${ctx.workspaceId} AND ${alive} AND ${col} IS NOT NULL
        AND lower(regexp_replace(trim(${col}), '\\s+', ' ', 'g')) = ANY(${values})
        ${entity === 'deal' ? sql`AND ${scopeWhere(ctx, 'deal', 'view', 't')}` : sql``}`, db);
      for (const f of found) index.add(key, f.v, Number(f.id));
      continue;
    }
    const found = key === 'name'
      ? await q<{ id: number; v: string }>(entity === 'company'
        ? sql`SELECT t.id, lower(regexp_replace(trim(t.name), '\\s+', ' ', 'g')) AS v FROM companies t
              WHERE t.workspace_id = ${ctx.workspaceId} AND ${alive} AND lower(regexp_replace(trim(t.name), '\\s+', ' ', 'g')) = ANY(${values})`
        : sql`SELECT t.id, lower(regexp_replace(trim(coalesce(t.first_name,'') || ' ' || coalesce(t.last_name,'')), '\\s+', ' ', 'g')) AS v
              FROM ${table} t WHERE t.workspace_id = ${ctx.workspaceId} AND ${alive}
              AND lower(regexp_replace(trim(coalesce(t.first_name,'') || ' ' || coalesce(t.last_name,'')), '\\s+', ' ', 'g')) = ANY(${values})`, db)
      : await q<{ id: number; v: string }>(sql`SELECT DISTINCT t.id, cm.normalized AS v FROM contact_methods cm
              JOIN ${table} t ON t.id = cm.party_id
              WHERE cm.workspace_id = ${ctx.workspaceId} AND cm.party_type = ${entity} AND cm.kind = ${key}
                AND cm.normalized = ANY(${values}) AND ${alive}`, db);
    for (const f of found) index.add(key, f.v, Number(f.id));
  }
  return index;
}

// ───────────────────────── Decide ─────────────────────────

export type Decision =
  | { action: 'create' }
  | { action: 'update'; id: number | string }
  | { action: 'skip'; id?: number | string; message: string }
  | { action: 'error'; message: string };

const refOf = (entity: ImportEntity, id: number | string, rowNumbers: number[]) =>
  typeof id === 'number' ? `${NOUN[entity]} #${id}` : `the ${NOUN[entity]} from row ${rowNumbers[Number(id.slice(4))]}`;

export function decide(entity: ImportEntity, matches: (number | string)[], options: ImportOptions, rowNumbers: number[],
  owners: Map<number, { owner_id: number; visibility: string }>, ctx: Ctx): Decision {
  if (!matches.length || options.duplicateMode === 'create') return { action: 'create' };
  if (matches.length > 1) {
    const list = matches.slice(0, 3).map((m) => refOf(entity, m, rowNumbers)).join(', ');
    return options.duplicateMode === 'skip'
      ? { action: 'skip', message: `Already exists (matches ${matches.length}: ${list})` }
      : { action: 'error', message: `Matches ${matches.length} existing records (${list}); merge them first or import as new` };
  }
  const id = matches[0];
  if (options.duplicateMode === 'skip') return { action: 'skip', id, message: `Already exists as ${refOf(entity, id, rowNumbers)}` };
  if (typeof id === 'number') {
    const o = owners.get(id);
    const allowed = OWNED(entity) ? !o || canOnRecord(ctx, importPermissionEntity(entity), 'edit', o) : scopeOf(ctx, importPermissionEntity(entity), 'edit') !== 'none';
    if (!allowed) return { action: 'error', message: `Matches ${refOf(entity, id, rowNumbers)}, which you are not allowed to edit` };
  }
  return { action: 'update', id };
}

async function loadOwners(db: Db, entity: ImportEntity, index: MatchIndex, rows: BuiltRow[], matchBy: MatchKey[]) {
  const ids = [...new Set(rows.flatMap((r) => index.find(r.keys, matchBy)).filter((x): x is number => typeof x === 'number'))];
  const out = new Map<number, { owner_id: number; visibility: string }>();
  if (!ids.length || !OWNED(entity)) return out;
  for (const r of await q<{ id: number; owner_id: number; visibility: string; pipeline_id?: number }>(sql`SELECT id, owner_id, visibility${entity === 'lead' || entity === 'deal' ? sql`, pipeline_id` : sql``}
    FROM ${raw(TABLE[entity])} WHERE id = ANY(${ids})`, db)) {
    out.set(Number(r.id), r);
  }
  return out;
}

/** Turn validation errors from the shared schemas / services into "Field: message" text. */
export function rowMessage(entity: ImportEntity, e: unknown, input?: Record<string, unknown>, defs: FieldDef[] = []): string {
  if (e instanceof RowError) return e.message;
  if (e instanceof AppError) {
    const first = Object.entries(e.fields ?? {})[0];
    if (!first) return e.message;
    const [path, msg] = first;
    const m = /^methods\.(\d+)/.exec(path);
    if (m) {
      const method = (input?.methods as ContactMethodInput[] | undefined)?.[Number(m[1])];
      return `${method ? { email: 'Email', phone: 'Phone', website: 'Website', messenger: 'Messenger' }[method.kind] : 'Contact details'}: ${msg}${method ? ` ("${method.value}")` : ''}`;
    }
    if (path.startsWith('custom.')) return e.code === 'REQUIRED_FIELDS' ? e.message : `${defs.find((d) => d.key === path.slice(7))?.label ?? path.slice(7)}: ${msg}`;
    const label = IMPORT_TARGETS[entity].find((t) => t.key === path)?.label;
    if (label) return `${label}: ${/too_big|at most|<=/i.test(msg) ? 'is too long' : msg}`;
    return e.message;
  }
  return 'Could not save this row (unexpected error)';
}

const CREATE_SCHEMA = { contact: contactCreateSchema, company: companyCreateSchema, lead: leadCreateSchema, deal: dealCreateSchema, product: productCreateSchema, deal_line: lineItemSchema };
const UPDATE_SCHEMA = { contact: contactUpdateSchema, company: companyUpdateSchema, lead: leadUpdateSchema, deal: dealUpdateSchema, product: productUpdateSchema, deal_line: lineItemSchema };

// ───────────────────────── Preview (no writes) ─────────────────────────

export interface PreviewRow { i: number; row: number; action: 'create' | 'update' | 'skip' | 'error'; title: string; recordId?: number; message?: string }
export interface Preview {
  summary: { create: number; update: number; skip: number; error: number; newCompanies: number; newOptions: number };
  rows: PreviewRow[];
}

export async function preview(ctx: Ctx, imp: ImportRow, mapping: (string | null)[], options: ImportOptions): Promise<Preview> {
  const entity = imp.entity_type;
  const rows = imp.rows ?? [];
  const lk = await loadLookups(pool, ctx, entity, options);
  const built: (BuiltRow | RowError)[] = rows.map((cells) => {
    try { return buildRow(entity, imp.headers, cells, mapping, lk, options); } catch (e) { if (e instanceof RowError) return e; throw e; }
  });
  const ok = built.filter((b): b is BuiltRow => !(b instanceof RowError));
  const matchBy = options.duplicateMode === 'create' ? [] : options.matchBy;
  const index = await loadMatches(pool, ctx, entity, ok, matchBy);
  const owners = await loadOwners(pool, entity, index, ok, matchBy);
  const knownCompanies = new Set<string>();
  const companyNames = [...new Set(ok.map((b) => b.companyName?.toLowerCase()).filter(Boolean))] as string[];
  if (companyNames.length) {
    for (const c of await q<{ n: string }>(sql`SELECT DISTINCT lower(name) AS n FROM companies WHERE workspace_id = ${ctx.workspaceId}
        AND deleted_at IS NULL AND lower(name) = ANY(${companyNames})`)) knownCompanies.add(c.n);
  }
  const summary = { create: 0, update: 0, skip: 0, error: 0, newCompanies: 0, newOptions: 0 };
  const optionsToAdd = new Set<string>();
  const contactIndex = entity === 'deal' ? await loadContactIndex(pool, ctx, ok) : null;
  const out: PreviewRow[] = [];
  for (let i = 0; i < built.length; i++) {
    const b = built[i];
    const base = { i, row: imp.row_numbers[i] ?? i + 2 };
    let r: PreviewRow;
    if (b instanceof RowError) r = { ...base, action: 'error', title: rows[i].filter(Boolean).slice(0, 2).join(' · ') || '—', message: b.message };
    else {
      const d = decide(entity, index.find(b.keys, matchBy), options, imp.row_numbers, owners, ctx);
      r = { ...base, action: d.action, title: b.title };
      if (d.action === 'skip' || d.action === 'error') r.message = d.message;
      if ((d.action === 'update' || d.action === 'skip') && typeof d.id === 'number') r.recordId = d.id;
      if (d.action === 'update' && typeof d.id === 'string') r.message = `Updates ${refOf(entity, d.id, imp.row_numbers)}`;
      if (d.action === 'create' || d.action === 'update') {
        // Validate exactly like the run will (schemas, custom fields, required fields), without writing.
        try {
          if (d.action === 'create') {
            const body = parse(CREATE_SCHEMA[entity], b.input) as { custom?: Record<string, unknown>; stageId?: number | null };
            await assertRequired(lk.defs, mergeCustom(lk.defs, body.custom), entity === 'lead' || entity === 'deal' ? (body.stageId ?? lk.defaultStageId) : undefined);
          } else {
            const body = parse(UPDATE_SCHEMA[entity], updateShape(b.input)) as { custom?: Record<string, unknown> };
            mergeCustom(lk.defs, body.custom);
          }
          if (contactIndex) for (const ref of b.contactRefs ?? []) contactIndex.resolve(ref);
          for (const o of b.newOptions ?? []) optionsToAdd.add(`${o.kind}:${o.label.toLowerCase()}`);
          if ((entity === 'contact' || entity === 'deal') && b.companyName && !knownCompanies.has(b.companyName.toLowerCase())) {
            if (!options.createCompanies) throw new RowError(`Company: "${b.companyName}" doesn't exist (turn on "Create missing companies" to add it)`);
            if (scopeOf(ctx, 'company', 'create') === 'none') throw new RowError(`Company: "${b.companyName}" doesn't exist and you can't create companies`);
            knownCompanies.add(b.companyName.toLowerCase());
            summary.newCompanies++;
          }
          if (d.action === 'create') index.addRow(b.keys, `row:${i}`);
        } catch (e) {
          if (!(e instanceof RowError) && !(e instanceof AppError)) throw e;
          r = { ...base, action: 'error', title: b.title, message: rowMessage(entity, e, b.input, lk.defs) };
        }
      }
    }
    summary[r.action]++;
    out.push(r);
  }
  summary.newOptions = optionsToAdd.size;
  return { summary, rows: out };
}

/** Update payload: drop create-only defaults (pipeline, default owner) so they don't overwrite existing values. */
function updateShape(input: Record<string, unknown>): Record<string, unknown> {
  const { pipelineId: _p, ...rest } = input;
  void _p;
  return rest;
}

// ───────────────────────── Deal contacts ─────────────────────────

/** Contacts referenced by deal rows, by email (any of theirs) or by exact full name when that name is unique. */
async function loadContactIndex(db: Db, ctx: Ctx, rows: BuiltRow[]) {
  const refs = [...new Set(rows.flatMap((r) => r.contactRefs ?? []).map((r) => r.trim().toLowerCase()))];
  const byEmail = new Map<string, number>();
  const byName = new Map<string, number[]>();
  const emails = refs.filter((r) => r.includes('@')).map((r) => normalizeContactValue('email', r));
  const names = refs.filter((r) => !r.includes('@')).map((r) => r.replace(/\s+/g, ' '));
  if (emails.length) {
    for (const c of await q<{ id: number; v: string }>(sql`SELECT DISTINCT t.id, cm.normalized AS v FROM contact_methods cm JOIN contacts t ON t.id = cm.party_id
        WHERE cm.workspace_id = ${ctx.workspaceId} AND cm.party_type = 'contact' AND cm.kind = 'email' AND cm.normalized = ANY(${emails})
        AND t.deleted_at IS NULL AND ${scopeWhere(ctx, 'contact', 'view', 't')}`, db)) byEmail.set(c.v, Number(c.id));
  }
  if (names.length) {
    for (const c of await q<{ id: number; v: string }>(sql`SELECT t.id, lower(regexp_replace(trim(coalesce(t.first_name,'') || ' ' || coalesce(t.last_name,'')), '\\s+', ' ', 'g')) AS v
        FROM contacts t WHERE t.workspace_id = ${ctx.workspaceId} AND t.deleted_at IS NULL AND ${scopeWhere(ctx, 'contact', 'view', 't')}
        AND lower(regexp_replace(trim(coalesce(t.first_name,'') || ' ' || coalesce(t.last_name,'')), '\\s+', ' ', 'g')) = ANY(${names})`, db)) {
      byName.set(c.v, [...(byName.get(c.v) ?? []), Number(c.id)]);
    }
  }
  return {
    /** Contact id for a reference, or a RowError explaining why it can't be linked. */
    resolve(ref: string): number {
      const r = ref.trim().toLowerCase();
      if (r.includes('@')) return byEmail.get(normalizeContactValue('email', r)) ?? fail(`Contact: no contact with the email "${ref}"`);
      const ids = byName.get(r.replace(/\s+/g, ' ')) ?? [];
      if (ids.length > 1) fail(`Contact: ${ids.length} contacts are called "${ref}"; use their email instead`);
      return ids[0] ?? fail(`Contact: no contact called "${ref}" (contacts are linked, not created; import them first)`);
    },
  };
}

/** "Add missing list options": find or create the list value (admins only — checked when lookups are built). */
async function ensureOption(db: Db, ctx: Ctx, kind: string, label: string, extra: Record<string, unknown>): Promise<number> {
  if (kind === CATEGORY) {
    const row = await q1<{ id: number }>(sql`INSERT INTO product_categories (workspace_id, name, sort)
      VALUES (${ctx.workspaceId}, ${label}, (SELECT coalesce(max(sort),0)+1 FROM product_categories WHERE workspace_id = ${ctx.workspaceId}))
      ON CONFLICT (workspace_id, name) DO UPDATE SET name = excluded.name RETURNING id`, db);
    return Number(row!.id);
  }
  const found = await q1<{ id: number; is_active: boolean }>(sql`SELECT id, is_active FROM dictionary_items WHERE workspace_id = ${ctx.workspaceId}
    AND kind = ${kind} AND lower(label) = lower(${label}) ORDER BY is_active DESC, id LIMIT 1`, db);
  if (found) {
    if (!found.is_active) await q(sql`UPDATE dictionary_items SET is_active = true WHERE id = ${found.id}`, db);
    return Number(found.id);
  }
  const row = await q1<{ id: number }>(sql`INSERT INTO dictionary_items (workspace_id, kind, label, sort)
    VALUES (${ctx.workspaceId}, ${kind}, ${label}, (SELECT coalesce(max(sort),0)+1 FROM dictionary_items WHERE workspace_id = ${ctx.workspaceId} AND kind = ${kind}))
    RETURNING id`, db);
  await audit(db, ctx, 'dictionary', Number(row!.id), 'created', { kind, label, ...extra });
  return Number(row!.id);
}

// ───────────────────────── Execution ─────────────────────────

async function resolveCompany(db: Db, ctx: Ctx, name: string, options: ImportOptions, extra: Record<string, unknown>): Promise<number> {
  const found = await q1<{ id: number }>(sql`SELECT id FROM companies WHERE workspace_id = ${ctx.workspaceId} AND deleted_at IS NULL
    AND lower(name) = lower(${name}) ORDER BY id LIMIT 1`, db);
  if (found) return Number(found.id);
  if (!options.createCompanies) fail(`Company: "${name}" doesn't exist (turn on "Create missing companies" to add it)`);
  if (scopeOf(ctx, 'company', 'create') === 'none') fail(`Company: "${name}" doesn't exist and you can't create companies`);
  const body = parse(companyCreateSchema, { name, ownerId: options.ownerId ?? undefined });
  return (await createCompany(db, ctx, body, extra)).id;
}

async function executeRow(db: Db, ctx: Ctx, imp: ImportRow, b: BuiltRow, d: Decision, options: ImportOptions): Promise<RowResult & { i: number }> {
  const entity = imp.entity_type;
  const extra = { _import: { id: imp.id, file: imp.file_name } };
  const events = options.runAutomation;
  const input = { ...b.input };
  if (entity === 'deal_line') return executeLine(db, ctx, b, extra);
  for (const o of b.newOptions ?? []) {
    if (o.kind.startsWith('custom:')) await ensureCustomOption(db, ctx, entity, o.kind.slice(7), o.id!, o.label, extra);
    else input[o.field] = await ensureOption(db, ctx, o.kind, o.label, extra);
  }
  const contactIds = entity === 'deal' && b.contactRefs?.length ? (await loadContactIndex(db, ctx, [b])).resolve : null;
  if (d.action === 'create') {
    if (OWNED(entity)) input.ownerId ??= options.ownerId ?? undefined;
    if (entity === 'contact' && b.companyName) input.primaryCompanyId = await resolveCompany(db, ctx, b.companyName, options, extra);
    if (entity === 'deal' && b.companyName) input.companyId = await resolveCompany(db, ctx, b.companyName, options, extra);
    if (contactIds) input.contactIds = [...new Set(b.contactRefs!.map(contactIds))];
    const body = parse(CREATE_SCHEMA[entity], input);
    const row = entity === 'contact' ? await createContact(db, ctx, body as never, extra)
      : entity === 'company' ? await createCompany(db, ctx, body as never, extra)
        : entity === 'deal' ? await createDeal(db, ctx, body as never, { extra, events })
          : entity === 'product' ? await createProduct(db, ctx, body as never, extra)
            : await createLead(db, ctx, body as never, { extra, events });
    return { i: -1, action: 'created', id: Number(row.id) };
  }
  if (d.action !== 'update' || typeof d.id !== 'number') throw new Error('executeRow: unexpected decision');
  const id = d.id;
  const upd = updateShape(input);
  // Contact details: add new values, keep existing ones.
  if (upd.methods) {
    const existing = (await loadMethods(entity, [id], db))[id] ?? [];
    const have = new Set(existing.map((m) => `${m.kind}:${normalizeContactValue(m.kind, m.value)}`));
    const fresh = (upd.methods as ContactMethodInput[]).filter((m) => !have.has(`${m.kind}:${normalizeContactValue(m.kind, m.value)}`));
    upd.methods = fresh.length ? [...existing.map((m) => ({ kind: m.kind, label: m.label, value: m.value })), ...fresh] : undefined;
  }
  if (upd.address) {
    const cur = await q1<{ address: Record<string, unknown> | null }>(sql`SELECT address FROM ${raw(TABLE[entity])} WHERE id = ${id}`, db);
    upd.address = { ...(cur?.address ?? {}), ...(upd.address as Record<string, unknown>) };
  }
  if (entity === 'deal' && b.companyName) upd.companyId = await resolveCompany(db, ctx, b.companyName, options, extra);
  if (contactIds) {
    // Add the file's contacts to the deal's existing ones.
    const cur = await q<{ contact_id: number }>(sql`SELECT contact_id FROM deal_contacts WHERE deal_id = ${id} ORDER BY is_primary DESC`, db);
    const ids = cur.map((c) => Number(c.contact_id));
    const fresh = b.contactRefs!.map(contactIds).filter((c) => !ids.includes(c));
    if (fresh.length) upd.contactIds = [...ids, ...new Set(fresh)];
  }
  if (entity === 'contact' && b.companyName) {
    const companyId = await resolveCompany(db, ctx, b.companyName, options, extra);
    const cur = await q1<{ primary_company_id: number | null }>(sql`SELECT primary_company_id FROM contacts WHERE id = ${id}`, db);
    if (!cur?.primary_company_id) upd.primaryCompanyId = companyId;
    else {
      const linked = await q<{ company_id: number }>(sql`SELECT company_id FROM contact_companies WHERE contact_id = ${id}`, db);
      const ids = linked.map((l) => Number(l.company_id));
      if (!ids.includes(companyId)) upd.companyIds = [...ids, companyId];
    }
  }
  const body = parse(UPDATE_SCHEMA[entity], upd);
  if (entity === 'contact') await updateContact(db, ctx, id, body as never, extra);
  else if (entity === 'company') await updateCompany(db, ctx, id, body as never, extra);
  else if (entity === 'deal') await updateDeal(db, ctx, id, body as never, { extra, events });
  else if (entity === 'product') await updateProduct(db, ctx, id, body as never, extra);
  else await updateLead(db, ctx, id, body as never, { extra, events });
  return { i: -1, action: 'updated', id };
}

/** Process the next chunk of a queued/running import. Returns true when more chunks remain (a job was queued). */
export async function runChunk(importId: number): Promise<boolean> {
  return tx(async (db) => {
    const imp = await q1<ImportRow>(sql`SELECT * FROM imports WHERE id = ${importId} FOR UPDATE`, db);
    if (!imp || !['queued', 'running'].includes(imp.status)) return false;
    const finish = async (status: 'done' | 'failed', error: string | null = null) => {
      await q(sql`UPDATE imports SET status = ${status}, error = ${error}, finished_at = now() WHERE id = ${importId}`, db);
    };
    const ctx = await ctxForUser(imp.workspace_id, imp.created_by, db);
    if (!ctx) { await finish('failed', 'The person who started this import no longer has access to the workspace'); return false; }
    if (scopeOf(ctx, importPermissionEntity(imp.entity_type), 'import') === 'none') { await finish('failed', 'Import permission was removed before the import finished'); return false; }
    if (imp.status === 'queued') await q(sql`UPDATE imports SET status = 'running', started_at = now() WHERE id = ${importId}`, db);

    const from = imp.processed;
    const to = Math.min(from + IMPORT_LIMITS.chunkSize, imp.row_count);
    const slice = await q1<{ rows: string[][] | null }>(sql`SELECT (SELECT jsonb_agg(e ORDER BY n) FROM jsonb_array_elements(rows) WITH ORDINALITY x(e, n)
      WHERE n > ${from} AND n <= ${to}) AS rows FROM imports WHERE id = ${importId}`, db);
    const cells = slice?.rows ?? [];
    const options = imp.options;
    const matchBy = options.duplicateMode === 'create' ? [] : options.matchBy;
    const lk = await loadLookups(db, ctx, imp.entity_type, options);
    const built = cells.map((c) => { try { return buildRow(imp.entity_type, imp.headers, c, imp.mapping, lk, options); } catch (e) { if (e instanceof RowError) return e; throw e; } });
    const ok = built.filter((b): b is BuiltRow => !(b instanceof RowError));
    const index = await loadMatches(db, ctx, imp.entity_type, ok, matchBy);
    // Rows from earlier chunks are in the database now, so loadMatches finds them; rows of this chunk are added as we go.
    const owners = await loadOwners(db, imp.entity_type, index, ok, matchBy);
    const results: RowResult[] = [];
    const counts = { created: 0, updated: 0, skipped: 0, failed: 0 };
    for (let k = 0; k < built.length; k++) {
      const i = from + k;
      const b = built[k];
      let res: RowResult;
      if (b instanceof RowError) res = { i, action: 'failed', message: b.message };
      else {
        const d = decide(imp.entity_type, index.find(b.keys, matchBy), options, imp.row_numbers, owners, ctx);
        if (d.action === 'skip') res = { i, action: 'skipped', message: d.message, ...(typeof d.id === 'number' ? { id: d.id } : {}) };
        else if (d.action === 'error') res = { i, action: 'failed', message: d.message };
        else {
          await q(sql`SAVEPOINT import_row`, db);
          try {
            const r = await executeRow(db, ctx, imp, b, d, options);
            await q(sql`RELEASE SAVEPOINT import_row`, db);
            res = { ...r, i };
            if (r.action === 'created') index.addRow(b.keys, r.id!);
          } catch (e) {
            await q(sql`ROLLBACK TO SAVEPOINT import_row`, db);
            if (!(e instanceof RowError) && !(e instanceof AppError) && process.env.NODE_ENV !== 'test') console.error(`import ${importId} row ${i}`, e);
            res = { i, action: 'failed', message: rowMessage(imp.entity_type, e, b.input, lk.defs) };
          }
        }
      }
      counts[res.action]++;
      results.push(res);
    }
    const done = to >= imp.row_count;
    await q(sql`UPDATE imports SET processed = ${to}, results = results || ${JSON.stringify(results)}::jsonb,
      created_count = created_count + ${counts.created}, updated_count = updated_count + ${counts.updated},
      skipped_count = skipped_count + ${counts.skipped}, failed_count = failed_count + ${counts.failed}
      ${done ? sql`, status = 'done', finished_at = now()` : sql``} WHERE id = ${importId}`, db);
    if (done) {
      const total = await q1<Record<string, number>>(sql`SELECT created_count, updated_count, skipped_count, failed_count FROM imports WHERE id = ${importId}`, db);
      await audit(db, ctx, 'import', importId, 'imported', { file: imp.file_name, entity: imp.entity_type, ...total });
      return false;
    }
    await q(sql`INSERT INTO jobs (type, payload) VALUES ('import.run', ${JSON.stringify({ importId })})`, db);
    return true;
  });
}

// ───────────────────────── Custom select options ("add missing values") ─────────────────────────

async function ensureCustomOption(db: Db, ctx: Ctx, entity: ImportEntity, key: string, id: string, label: string, extra: Record<string, unknown>) {
  const r = await q1<{ id: number }>(sql`UPDATE field_definitions SET options = options || jsonb_build_array(jsonb_build_object('id', ${id}::text, 'label', ${label}::text))
    WHERE workspace_id = ${ctx.workspaceId} AND entity_type = ${entity} AND key = ${key}
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(options) o WHERE o->>'id' = ${id} OR lower(o->>'label') = lower(${label}))
    RETURNING id`, db);
  if (r) await audit(db, ctx, 'field', Number(r.id), 'option_added', { key, option: { id, label }, ...extra });
}

// ───────────────────────── "Products on deals": one product line per row ─────────────────────────

interface LineDeal { id: number; title: string; canEdit: boolean }
interface LineLookups {
  dealsByTitle: Map<string, LineDeal[]>;
  dealsById: Map<number, LineDeal>;
  /** The role's field permissions lock the deal amount (products drive it). */
  amountLocked: boolean;
  products: Map<string, { id: number; name: string; unit_price: string; unit: string; tax_rate: string | null; tax_included: boolean }>;
}

async function loadLineLookups(db: Db, ctx: Ctx): Promise<LineLookups> {
  const rows = await q<{ id: number; title: string; owner_id: number; visibility: string; pipeline_id: number }>(sql`SELECT d.id, d.title, d.owner_id, d.visibility, d.pipeline_id FROM deals d
    WHERE d.workspace_id = ${ctx.workspaceId} AND d.deleted_at IS NULL AND ${scopeWhere(ctx, 'deal', 'view', 'd')}`, db);
  const deals: LineDeal[] = rows.map((d) => ({ id: Number(d.id), title: d.title, canEdit: canOnRecord(ctx, 'deal', 'edit', d) }));
  const dealsByTitle = new Map<string, LineDeal[]>();
  for (const d of deals) {
    const k = d.title.toLowerCase().trim().replace(/\s+/g, ' ');
    dealsByTitle.set(k, [...(dealsByTitle.get(k) ?? []), d]);
  }
  const products = new Map<string, LineLookups['products'] extends Map<string, infer P> ? P : never>();
  for (const p of await q<{ id: number; name: string; sku: string | null; unit_price: string; unit: string; tax_rate: string | null; tax_included: boolean }>(sql`
      SELECT id, name, sku, unit_price, unit, tax_rate, tax_included FROM products WHERE workspace_id = ${ctx.workspaceId} AND deleted_at IS NULL ORDER BY is_active DESC, id`, db)) {
    if (p.sku && !products.has(`sku:${p.sku.toLowerCase().trim()}`)) products.set(`sku:${p.sku.toLowerCase().trim()}`, p);
    if (!products.has(`name:${p.name.toLowerCase().trim()}`)) products.set(`name:${p.name.toLowerCase().trim()}`, p);
  }
  return { dealsByTitle, dealsById: new Map(deals.map((d) => [d.id, d])), products, amountLocked: !!fieldRule(ctx, 'deal', 'amount') };
}

const pct = (label: string, v: string) => {
  const n = normalizeNumberCell(v.replace('%', ''));
  return n !== null && Number(n) >= 0 && Number(n) <= 100 ? Number(n) : fail(`${label}: "${v}" must be a number from 0 to 100`);
};

function buildLineRow(cells: string[], mapping: (string | null)[], ll: LineLookups): BuiltRow {
  const cell: Record<string, string> = {};
  mapping.forEach((key, col) => { const v = (cells[col] ?? '').trim(); if (key && v && !(key in cell)) cell[key] = v; });
  // Deal: by ID when given, otherwise by name (must be unique among the deals you can see).
  if (ll.amountLocked) fail('Your role can’t change deal amounts or products');
  let deal: LineDeal | undefined;
  if (cell.dealId) {
    deal = ll.dealsById.get(Number(cell.dealId.replace(/^#/, ''))) ?? fail(`Deal ID: no deal #${cell.dealId} that you can see`);
  } else if (cell.deal) {
    const hits = ll.dealsByTitle.get(cell.deal.toLowerCase().replace(/\s+/g, ' ')) ?? [];
    if (hits.length > 1) fail(`Deal: ${hits.length} deals are called "${cell.deal}" — add a Deal ID column`);
    deal = hits[0] ?? fail(`Deal: no deal called "${cell.deal}" that you can see (deals are not created by this import)`);
  } else fail('Deal: empty');
  if (!deal!.canEdit) fail(`Deal: you can’t edit "${deal!.title}"`);
  if (!cell.product) fail('Product: empty');
  const p = ll.products.get(`sku:${cell.product.toLowerCase()}`) ?? ll.products.get(`name:${cell.product.toLowerCase()}`);
  const unitPrice = cell.unitPrice ? (normalizeNumberCell(cell.unitPrice) ?? fail(`Unit price: "${cell.unitPrice}" is not an amount`))
    : p ? p.unit_price : fail(`Unit price: "${cell.product}" is not in the product list, so a price is needed`);
  const quantity = cell.quantity ? Number(normalizeNumberCell(cell.quantity) ?? fail(`Quantity: "${cell.quantity}" is not a number`)) : 1;
  if (!(quantity > 0)) fail('Quantity: must be more than 0');
  const discount = cell.discount ? pct('Discount %', cell.discount) : 0;
  const taxIncluded = cell.taxIncluded ? (parseBoolCell(cell.taxIncluded) ?? fail('Price includes tax: use yes or no')) : (p?.tax_included ?? false);
  const name = p?.name ?? cell.product;
  return {
    input: {
      dealId: deal!.id, productId: p ? Number(p.id) : null, name, unitPrice, quantity, unit: cell.unit || p?.unit || 'pcs',
      discountType: discount ? 'percent' : null, discountValue: discount || null,
      taxRate: cell.taxRate ? pct('Tax %', cell.taxRate) : (p?.tax_rate === null || p?.tax_rate === undefined ? null : Number(p.tax_rate)),
      taxIncluded,
    },
    keys: {}, title: `${name} → ${deal!.title}`,
  };
}

async function executeLine(db: Db, ctx: Ctx, b: BuiltRow, extra: Record<string, unknown>): Promise<RowResult & { i: number }> {
  const dealId = Number(b.input.dealId);
  const deal = await q1<{ id: number; owner_id: number; visibility: string; pipeline_id: number }>(sql`SELECT id, owner_id, visibility, pipeline_id FROM deals
    WHERE id = ${dealId} AND workspace_id = ${ctx.workspaceId} AND deleted_at IS NULL FOR UPDATE`, db);
  if (!deal) fail('Deal: no longer exists');
  assertOnRecord(ctx, 'deal', 'edit', deal!);
  assertCanChange(ctx, 'deal', ['amount']); // products drive the amount (field permissions)
  const item = parse(lineItemSchema, b.input);
  const r = calcLine(item);
  const before = await q1<{ n: number }>(sql`SELECT count(*)::int AS n FROM line_items WHERE parent_type = 'deal' AND parent_id = ${dealId}`, db);
  const row = await q1<{ id: number }>(sql`INSERT INTO line_items (workspace_id, parent_type, parent_id, product_id, name, unit_price, quantity, unit, discount_type, discount_value, tax_rate, tax_included, line_total, sort)
    VALUES (${ctx.workspaceId}, 'deal', ${dealId}, ${item.productId ?? null}, ${item.name}, ${item.unitPrice}, ${item.quantity}, ${item.unit}, ${item.discountType ?? null}, ${item.discountValue ?? 0},
      ${item.taxRate ?? null}, ${item.taxIncluded ?? false}, ${r.lineTotal}, (SELECT coalesce(max(sort), -1) + 1 FROM line_items WHERE parent_type = 'deal' AND parent_id = ${dealId}))
    RETURNING id`, db);
  await recalcDealAmount(db, ctx, dealId);
  await audit(db, ctx, 'deal', dealId, 'updated', { lineItems: [before?.n ?? 0, (before?.n ?? 0) + 1], ...extra });
  return { i: -1, action: 'created', id: Number(row!.id) };
}
