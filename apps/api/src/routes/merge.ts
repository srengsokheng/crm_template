/**
 * Merge duplicate contacts, companies or leads into one — two or more at a time (up to MERGE_MAX).
 *
 * The kept record ("survivor") takes the chosen field values; everything attached to the other records moves over:
 * contact details (without duplicates), deals, company/contact links, activities, notes, files, converted-lead links,
 * notifications and history (leads: also their products when the kept lead has none). The other records are
 * soft-deleted with `merged_into_id` set, so old links can point to the survivor. One transaction, all rows locked in id
 * order; audited as `merged` on the survivor (one event per merged record) and `merged_into` on each merged one.
 */
import type { FastifyInstance } from 'fastify';
import { MERGE_ENTITIES, MERGE_MAX, mergeSchema, normalizeContactValue, personName } from '@crm/shared';
import { join, q, q1, raw, sql, tx, type Db, type Fragment } from '../db/index.ts';
import { audit } from '../lib/audit.ts';
import { loadMethods } from '../lib/contactMethods.ts';
import type { Ctx } from '../lib/context.ts';
import { loadDefs } from '../lib/customFields.ts';
import { fieldRule, hiddenCustomKeys, stripHidden } from '../lib/fieldAccess.ts';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.ts';
import { ctxOf } from '../lib/http.ts';
import { assertOnRecord, canOnRecord } from '../lib/permissions.ts';
import { camel, camelAll, updateRow } from '../lib/records.ts';
import { parse } from '../lib/validate.ts';

type Entity = (typeof MERGE_ENTITIES)[number];
/** Merges can be undone for this many days (while the kept record hasn't been edited since). */
export const UNDO_DAYS = 7;
interface MergeSnapshot {
  survivor: Record<string, unknown>;
  titles: Record<number, string>;
  methods: Record<string, unknown>[];
  activityLinks: Record<string, unknown>[];
  dealContacts: Record<string, unknown>[];
  contactCompanies: Record<string, unknown>[];
  /** Per merged record: ids of rows moved to the kept record, by kind. */
  moved: Record<number, Record<string, number[]>>;
}
type Row = Record<string, unknown> & { id: number; owner_id: number; visibility: string; custom: Record<string, unknown>; created_at: Date };

const TABLE: Record<Entity, string> = { contact: 'contacts', company: 'companies', lead: 'leads' };
const NOUN: Record<Entity, string> = { contact: 'Contact', company: 'Company', lead: 'Lead' };

/** Choosable fields → the columns they set together. */
export const MERGE_FIELDS: Record<Entity, { key: string; label: string; cols: string[] }[]> = {
  contact: [
    { key: 'name', label: 'Name', cols: ['first_name', 'last_name'] },
    { key: 'jobTitle', label: 'Job title', cols: ['job_title'] },
    { key: 'birthday', label: 'Birthday', cols: ['birthday'] },
    { key: 'typeId', label: 'Type', cols: ['type_id'] },
    { key: 'sourceId', label: 'Source', cols: ['source_id'] },
    { key: 'primaryCompanyId', label: 'Main company', cols: ['primary_company_id'] },
    { key: 'address', label: 'Address', cols: ['address'] },
    { key: 'description', label: 'Notes', cols: ['description'] },
    { key: 'ownerId', label: 'Owner', cols: ['owner_id'] },
    { key: 'visibility', label: 'Visibility', cols: ['visibility'] },
  ],
  company: [
    { key: 'name', label: 'Name', cols: ['name'] },
    { key: 'typeId', label: 'Type', cols: ['type_id'] },
    { key: 'industryId', label: 'Industry', cols: ['industry_id'] },
    { key: 'sizeId', label: 'Size', cols: ['size_id'] },
    { key: 'sourceId', label: 'Source', cols: ['source_id'] },
    { key: 'annualRevenue', label: 'Annual revenue', cols: ['annual_revenue', 'currency'] },
    { key: 'address', label: 'Address', cols: ['address'] },
    { key: 'description', label: 'Description', cols: ['description'] },
    { key: 'ownerId', label: 'Owner', cols: ['owner_id'] },
    { key: 'visibility', label: 'Visibility', cols: ['visibility'] },
  ],
  lead: [
    { key: 'title', label: 'Lead name', cols: ['title'] },
    { key: 'name', label: 'Person', cols: ['first_name', 'last_name'] },
    { key: 'jobTitle', label: 'Job title', cols: ['job_title'] },
    { key: 'companyName', label: 'Company name', cols: ['company_name'] },
    { key: 'amount', label: 'Amount', cols: ['amount', 'currency'] },
    { key: 'sourceId', label: 'Source', cols: ['source_id'] },
    { key: 'sourceDetails', label: 'Source details', cols: ['source_details'] },
    { key: 'address', label: 'Address', cols: ['address'] },
    { key: 'description', label: 'Description', cols: ['description'] },
    { key: 'ownerId', label: 'Owner', cols: ['owner_id'] },
    { key: 'visibility', label: 'Visibility', cols: ['visibility'] },
  ],
};

const isEmpty = (v: unknown) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)
  || (typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v) && Object.values(v as object).every((x) => x === null || x === ''));
const titleOf = (entity: Entity, r: Row) => (entity === 'contact' ? personName(r.first_name as string, r.last_name as string)
  : entity === 'lead' ? String(r.title ?? '') : String(r.name));

function entityOf(param: string): Entity {
  if (!(MERGE_ENTITIES as readonly string[]).includes(param)) throw notFound();
  return param as Entity;
}

async function lockActive(db: Db, ctx: Ctx, entity: Entity, id: number): Promise<Row> {
  const r = await q1<Row>(sql`SELECT * FROM ${raw(TABLE[entity])} WHERE id = ${id} AND workspace_id = ${ctx.workspaceId} AND deleted_at IS NULL FOR UPDATE`, db);
  if (!r) throw notFound(NOUN[entity]);
  return r;
}

/** Counts of what hangs off a record, shown before merging. */
async function related(db: Db, entity: Entity, id: number) {
  const common = sql`
    (SELECT count(*)::int FROM activity_links al JOIN activities a ON a.id = al.activity_id AND a.deleted_at IS NULL WHERE al.entity_type = ${entity} AND al.entity_id = ${id}) AS activities,
    (SELECT count(*)::int FROM notes WHERE entity_type = ${entity} AND entity_id = ${id} AND deleted_at IS NULL) AS notes`;
  const r = await q1<Record<string, number>>(entity === 'contact'
    ? sql`SELECT
        (SELECT count(*)::int FROM deal_contacts dc JOIN deals d ON d.id = dc.deal_id AND d.deleted_at IS NULL WHERE dc.contact_id = ${id}) AS deals,
        (SELECT count(*)::int FROM contact_companies WHERE contact_id = ${id}) AS companies, ${common}`
    : entity === 'company' ? sql`SELECT
        (SELECT count(*)::int FROM deals WHERE company_id = ${id} AND deleted_at IS NULL) AS deals,
        (SELECT count(*)::int FROM contact_companies cc JOIN contacts c ON c.id = cc.contact_id AND c.deleted_at IS NULL WHERE cc.company_id = ${id}) AS contacts, ${common}`
      : sql`SELECT (SELECT count(*)::int FROM line_items WHERE parent_type = 'lead' AND parent_id = ${id}) AS products, ${common}`, db);
  return r ?? {};
}

/** Leads that were converted have become deals/contacts; they can't be merged. */
function assertMergeable(entity: Entity, r: Row) {
  if (entity === 'lead' && r.status === 'won') throw badRequest(`“${titleOf(entity, r)}” was already converted and can't be merged`);
}

export async function mergeRoutes(app: FastifyInstance) {
  // Side-by-side comparison of 2–MERGE_MAX records (all must be visible to the caller).
  app.get<{ Params: { entity: string }; Querystring: { ids?: string } }>('/merge/:entity', async (req) => {
    const ctx = ctxOf(req);
    const entity = entityOf(req.params.entity);
    const ids = [...new Set((req.query.ids ?? '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (ids.length < 2) throw badRequest('Choose at least two different records');
    if (ids.length > MERGE_MAX) throw badRequest(`Merge up to ${MERGE_MAX} records at a time`);
    return tx(async (db) => {
      const rows: Row[] = [];
      for (const id of ids) {
        const r = await q1<Row>(sql`SELECT * FROM ${raw(TABLE[entity])} WHERE id = ${id} AND workspace_id = ${ctx.workspaceId} AND deleted_at IS NULL`, db);
        if (!r) throw notFound(NOUN[entity]);
        assertOnRecord(ctx, entity, 'view', r);
        rows.push(r);
      }
      const methods = await loadMethods(entity, ids, db);
      const records = [];
      for (const r of rows) {
        records.push({
          ...stripHidden(ctx, entity, camel(r)), title: titleOf(entity, r),
          // Contacts: name of the main company, for display. (Leads have their own companyName field — leave it alone.)
          ...(entity === 'contact' ? { companyName: r.primary_company_id ? (await q1<{ name: string }>(sql`SELECT name FROM companies WHERE id = ${r.primary_company_id as number}`, db))?.name ?? null : null } : {}),
          methods: camelAll((methods[r.id] ?? []) as unknown as Record<string, unknown>[]), related: await related(db, entity, r.id),
          // Keeping a record needs edit on it; merging it away needs delete. (Keeping one = canKeep on it and canRemove on all others.)
          canKeep: canOnRecord(ctx, entity, 'edit', r),
          canRemove: canOnRecord(ctx, entity, 'delete', r),
          blocked: entity === 'lead' && r.status === 'won' ? 'Already converted' : null,
        });
      }
      const hidden = hiddenCustomKeys(ctx, entity);
      const defs = (await loadDefs(ctx.workspaceId, entity, db)).filter((d) => !hidden.includes(d.key));
      const locked = (key: string) => (key === 'name' ? !!(fieldRule(ctx, entity, 'firstName') || fieldRule(ctx, entity, 'lastName')) : !!fieldRule(ctx, entity, key));
      return {
        records,
        fields: MERGE_FIELDS[entity].map(({ key, label }) => ({ key, label, locked: locked(key) })),
        customFields: defs.map((d) => ({ key: d.key, label: d.label, type: d.type, options: d.options, locked: !!fieldRule(ctx, entity, `custom.${d.key}`) })),
        max: MERGE_MAX,
      };
    });
  });

  app.post<{ Params: { entity: string } }>('/merge/:entity', async (req) => {
    const ctx = ctxOf(req);
    const entity = entityOf(req.params.entity);
    const body = parse(mergeSchema, req.body);
    const mergedIds = [...new Set(body.mergedIds ?? [body.mergedId!])];
    if (mergedIds.includes(body.survivorId)) throw badRequest('Choose different records to merge');
    if (mergedIds.length + 1 > MERGE_MAX) throw badRequest(`Merge up to ${MERGE_MAX} records at a time`);
    const table = raw(TABLE[entity]);
    return tx(async (db) => {
      // Lock in id order so two concurrent merges touching the same records can't deadlock.
      const locked: Record<number, Row> = {};
      for (const id of [body.survivorId, ...mergedIds].sort((a, b) => a - b)) locked[id] = await lockActive(db, ctx, entity, id);
      const keep = locked[body.survivorId];
      const gones = mergedIds.map((id) => locked[id]);
      assertOnRecord(ctx, entity, 'edit', keep);
      for (const g of gones) assertOnRecord(ctx, entity, 'delete', g);
      for (const r of [keep, ...gones]) assertMergeable(entity, r);
      const S = keep.id;
      const all = [S, ...mergedIds];
      // Everything needed to undo this merge: the kept record, all contact details and link rows as they were, and
      // (filled in below) the ids of every row that is moved from a merged record to the kept one.
      const snap: MergeSnapshot = {
        survivor: keep, titles: Object.fromEntries(gones.map((g) => [g.id, titleOf(entity, g)])),
        methods: await q(sql`SELECT * FROM contact_methods WHERE party_type = ${entity} AND party_id = ANY(${all})`, db),
        activityLinks: await q(sql`SELECT activity_id, entity_id FROM activity_links WHERE entity_type = ${entity} AND entity_id = ANY(${all})`, db),
        dealContacts: entity === 'contact' ? await q(sql`SELECT deal_id, contact_id, is_primary FROM deal_contacts WHERE contact_id = ANY(${all})`, db) : [],
        contactCompanies: entity === 'contact' ? await q(sql`SELECT contact_id, company_id, role FROM contact_companies WHERE contact_id = ANY(${all})`, db)
          : entity === 'company' ? await q(sql`SELECT contact_id, company_id, role FROM contact_companies WHERE company_id = ANY(${all})`, db) : [],
        moved: {},
      };
      const ids = async (f: Fragment) => (await q<{ id: number }>(f, db)).map((r) => Number(r.id));

      // ── Field values ──
      // A choice names the record whose value wins. Locked/hidden fields ignore the user's choice; the automatic rule
      // (kept value, or the first non-empty merged value when the kept one is empty) still applies, so nothing is lost.
      const byId = new Map([keep, ...gones].map((r) => [r.id, r]));
      const isLocked = (key: string) => (key === 'name' ? !!(fieldRule(ctx, entity, 'firstName') || fieldRule(ctx, entity, 'lastName')) : !!fieldRule(ctx, entity, key));
      const source = (key: string, valueOf: (r: Row) => unknown): Row => {
        const c = isLocked(key) ? undefined : body.choose[key];
        if (c === 'survivor') return keep;
        if (c === 'merged') return gones[0];
        if (typeof c === 'number') {
          const r = byId.get(c);
          if (!r) throw badRequest(`“${key}”: record #${c} is not part of this merge`);
          return r;
        }
        return isEmpty(valueOf(keep)) ? (gones.find((g) => !isEmpty(valueOf(g))) ?? keep) : keep;
      };
      const values: Record<string, unknown> = {};
      const changes: Record<string, [unknown, unknown]> = {};
      for (const f of MERGE_FIELDS[entity]) {
        // A field is empty when its main column is (a default currency alone doesn't count as a value).
        const from = source(f.key, (r) => r[f.cols[0]]);
        if (from === keep) continue;
        for (const c of f.cols) {
          if (JSON.stringify(keep[c] ?? null) === JSON.stringify(from[c] ?? null)) continue;
          values[c] = from[c] ?? null;
          changes[c] = [keep[c] ?? null, from[c] ?? null];
        }
      }
      if (values.owner_id !== undefined) {
        const ok = await q1(sql`SELECT 1 FROM memberships WHERE workspace_id = ${ctx.workspaceId} AND user_id = ${values.owner_id as number} AND status <> 'disabled'`, db);
        if (!ok) throw badRequest('The chosen owner is no longer a member; keep another owner', { ownerId: 'Inactive user' });
      }
      const custom = { ...(keep.custom ?? {}) };
      for (const d of await loadDefs(ctx.workspaceId, entity, db, true)) {
        const from = source(`custom.${d.key}`, (r) => r.custom?.[d.key]);
        const a = keep.custom?.[d.key];
        const b = from.custom?.[d.key];
        if (from === keep || JSON.stringify(a ?? null) === JSON.stringify(b ?? null)) continue;
        if (isEmpty(b)) delete custom[d.key]; else custom[d.key] = b;
        changes[`custom.${d.key}`] = [a ?? null, b ?? null];
      }
      if (JSON.stringify(custom) !== JSON.stringify(keep.custom ?? {})) values.custom = custom;
      if (entity === 'contact' && !values.first_name && !values.last_name && !keep.first_name && !keep.last_name) {
        throw badRequest('The kept contact needs a name');
      }
      await updateRow(db, TABLE[entity], S, ctx.workspaceId, { ...values, updated_by: ctx.userId });
      const keptTitle = titleOf(entity, { ...keep, ...values } as Row);

      for (const [n, gone] of gones.entries()) {
        const M = gone.id;
        const moved: Record<string, number[]> = (snap.moved[M] = {});
        // ── Contact details: add the merged record's values that the survivor doesn't have yet ──
        const mine = (await loadMethods(entity, [S], db))[S] ?? [];
        const have = new Set(mine.map((m) => `${m.kind}:${normalizeContactValue(m.kind, m.value)}`));
        const primaries = new Set(mine.filter((m) => m.is_primary).map((m) => m.kind));
        let movedMethods = 0;
        for (const m of (await loadMethods(entity, [M], db))[M] ?? []) {
          const k = `${m.kind}:${normalizeContactValue(m.kind, m.value)}`;
          if (have.has(k)) continue;
          have.add(k);
          await q(sql`UPDATE contact_methods SET party_id = ${S}, is_primary = ${!primaries.has(m.kind)}, sort = sort + 100 WHERE id = ${m.id}`, db);
          primaries.add(m.kind);
          movedMethods++;
        }
        await q(sql`DELETE FROM contact_methods WHERE party_type = ${entity} AND party_id = ${M}`, db);

        // ── Relations ──
        if (entity === 'contact') {
          await q(sql`INSERT INTO deal_contacts (deal_id, contact_id, is_primary) SELECT deal_id, ${S}, is_primary FROM deal_contacts WHERE contact_id = ${M}
            ON CONFLICT (deal_id, contact_id) DO UPDATE SET is_primary = deal_contacts.is_primary OR EXCLUDED.is_primary`, db);
          await q(sql`DELETE FROM deal_contacts WHERE contact_id = ${M}`, db);
          await q(sql`INSERT INTO contact_companies (contact_id, company_id, role) SELECT ${S}, company_id, role FROM contact_companies WHERE contact_id = ${M}
            ON CONFLICT DO NOTHING`, db);
          await q(sql`DELETE FROM contact_companies WHERE contact_id = ${M}`, db);
          moved.leadsConvertedContact = await ids(sql`UPDATE leads SET converted_contact_id = ${S} WHERE workspace_id = ${ctx.workspaceId} AND converted_contact_id = ${M} RETURNING id`);
        } else if (entity === 'company') {
          moved.dealsCompany = await ids(sql`UPDATE deals SET company_id = ${S} WHERE workspace_id = ${ctx.workspaceId} AND company_id = ${M} RETURNING id`);
          await q(sql`INSERT INTO contact_companies (contact_id, company_id, role) SELECT contact_id, ${S}, role FROM contact_companies WHERE company_id = ${M}
            ON CONFLICT DO NOTHING`, db);
          await q(sql`DELETE FROM contact_companies WHERE company_id = ${M}`, db);
          moved.contactsPrimary = await ids(sql`UPDATE contacts SET primary_company_id = ${S} WHERE workspace_id = ${ctx.workspaceId} AND primary_company_id = ${M} RETURNING id`);
          moved.leadsConvertedCompany = await ids(sql`UPDATE leads SET converted_company_id = ${S} WHERE workspace_id = ${ctx.workspaceId} AND converted_company_id = ${M} RETURNING id`);
        } else {
          // Leads: the merged lead's products are added, except products the kept lead already has (same catalogue
          // product, or the same name for free-text lines) — like contact details, without duplicates.
          const keyOf = (l: { product_id: number | null; name: string }) => (l.product_id ? `p:${l.product_id}` : `n:${l.name.trim().toLowerCase()}`);
          const haveItems = new Set((await q<{ product_id: number | null; name: string }>(sql`SELECT product_id, name FROM line_items WHERE parent_type = 'lead' AND parent_id = ${S}`, db)).map(keyOf));
          moved.lineItems = [];
          for (const l of await q<{ id: number; product_id: number | null; name: string }>(sql`SELECT id, product_id, name FROM line_items WHERE parent_type = 'lead' AND parent_id = ${M} ORDER BY sort, id`, db)) {
            if (haveItems.has(keyOf(l))) continue;
            haveItems.add(keyOf(l));
            await q(sql`UPDATE line_items SET parent_id = ${S}, sort = sort + 1000 WHERE id = ${l.id}`, db);
            moved.lineItems.push(Number(l.id));
          }
          moved.dealsLead = await ids(sql`UPDATE deals SET lead_id = ${S} WHERE workspace_id = ${ctx.workspaceId} AND lead_id = ${M} RETURNING id`);
        }
        await q(sql`INSERT INTO activity_links (activity_id, entity_type, entity_id) SELECT activity_id, entity_type, ${S} FROM activity_links
          WHERE entity_type = ${entity} AND entity_id = ${M} ON CONFLICT DO NOTHING`, db);
        await q(sql`DELETE FROM activity_links WHERE entity_type = ${entity} AND entity_id = ${M}`, db);
        moved.notes = await ids(sql`UPDATE notes SET entity_id = ${S} WHERE workspace_id = ${ctx.workspaceId} AND entity_type = ${entity} AND entity_id = ${M} RETURNING id`);
        moved.attachments = await ids(sql`UPDATE attachments SET entity_id = ${S} WHERE workspace_id = ${ctx.workspaceId} AND entity_type = ${entity} AND entity_id = ${M} RETURNING id`);
        moved.notifications = await ids(sql`UPDATE notifications SET entity_id = ${S} WHERE workspace_id = ${ctx.workspaceId} AND entity_type = ${entity} AND entity_id = ${M} RETURNING id`);
        // History of the merged record continues on the survivor (field changes, creation, imports…).
        // Each moved event remembers which record it came from, so the timeline can say so.
        moved.audit = await ids(sql`UPDATE audit_events SET entity_id = ${S}, changes = changes || jsonb_build_object('_from', jsonb_build_object('id', ${M}::bigint, 'name', ${titleOf(entity, gone)}::text))
          WHERE workspace_id = ${ctx.workspaceId} AND entity_type = ${entity} AND entity_id = ${M} RETURNING id`);

        // ── Retire the merged record ──
        await q(sql`UPDATE ${table} SET deleted_at = now(), deleted_by = ${ctx.userId}, merged_into_id = ${S} WHERE id = ${M}`, db);
        // Records previously merged into M now point at S.
        moved.previouslyMerged = await ids(sql`UPDATE ${table} SET merged_into_id = ${S} WHERE workspace_id = ${ctx.workspaceId} AND merged_into_id = ${M} RETURNING id`);

        // Field changes are recorded once, with the first merged record.
        await audit(db, ctx, entity, S, 'merged', { merged: { id: M, name: titleOf(entity, gone) }, ...(n === 0 ? changes : {}), movedMethods });
        await audit(db, ctx, entity, M, 'merged_into', { into: { id: S, name: keptTitle } });
      }
      if (entity === 'contact') {
        // The main company is always one of the linked companies; without one, the first linked company becomes it.
        const primary = (values.primary_company_id ?? keep.primary_company_id) as number | null;
        if (primary) await q(sql`INSERT INTO contact_companies (contact_id, company_id) VALUES (${S}, ${primary}) ON CONFLICT DO NOTHING`, db);
        else {
          const first = await q1<{ company_id: number }>(sql`SELECT company_id FROM contact_companies WHERE contact_id = ${S} ORDER BY company_id LIMIT 1`, db);
          if (first) await q(sql`UPDATE contacts SET primary_company_id = ${first.company_id} WHERE id = ${S}`, db);
        }
      }
      const saved = await q1<{ id: number }>(sql`INSERT INTO merge_snapshots (workspace_id, entity_type, survivor_id, merged_ids, snapshot, created_by)
        VALUES (${ctx.workspaceId}, ${entity}, ${S}, ${mergedIds}, ${JSON.stringify(snap)}::jsonb, ${ctx.userId}) RETURNING id`, db);
      return { id: S, mergedId: mergedIds[0], mergedIds, undoId: Number(saved!.id) };
    });
  });

  // ── Undo ──
  /** The latest merge into this record that can still be undone (7 days, kept record not edited since), or null. */
  app.get<{ Params: { entity: string; id: string } }>('/merge/:entity/undoable/:id', async (req) => {
    const ctx = ctxOf(req);
    const entity = entityOf(req.params.entity);
    const r = await q1<{ id: number; merged_ids: number[]; snapshot: MergeSnapshot; created_at: Date }>(sql`SELECT m.id, m.merged_ids, m.snapshot, m.created_at
      FROM merge_snapshots m JOIN ${raw(TABLE[entity])} t ON t.id = m.survivor_id AND t.deleted_at IS NULL AND t.updated_at <= m.created_at
      WHERE m.workspace_id = ${ctx.workspaceId} AND m.entity_type = ${entity} AND m.survivor_id = ${Number(req.params.id)}
        AND m.undone_at IS NULL AND m.created_at > now() - ${UNDO_DAYS + ' days'}::interval
      ORDER BY m.id DESC LIMIT 1`);
    return r ? { undoId: Number(r.id), createdAt: r.created_at, merged: r.merged_ids.map((id) => ({ id: Number(id), title: r.snapshot.titles?.[id] ?? `#${id}` })) } : null;
  });

  app.post<{ Params: { entity: string; id: string } }>('/merge/:entity/undo/:id', async (req) => {
    const ctx = ctxOf(req);
    const entity = entityOf(req.params.entity);
    const table = raw(TABLE[entity]);
    return tx(async (db) => {
      const m = await q1<{ id: number; survivor_id: number; merged_ids: number[]; snapshot: MergeSnapshot; created_at: Date; undone_at: Date | null; fresh: boolean }>(sql`
        SELECT *, created_at > now() - ${UNDO_DAYS + ' days'}::interval AS fresh FROM merge_snapshots
        WHERE id = ${Number(req.params.id)} AND workspace_id = ${ctx.workspaceId} AND entity_type = ${entity} FOR UPDATE`, db);
      if (!m) throw notFound('Merge');
      if (m.undone_at) throw conflict('This merge was already undone');
      if (!m.fresh) throw conflict(`Merges can be undone for ${UNDO_DAYS} days`);
      const S = Number(m.survivor_id);
      const Ms = m.merged_ids.map(Number);
      const snap = m.snapshot;
      const keep = await q1<Row & { updated_at: Date }>(sql`SELECT * FROM ${table} WHERE id = ${S} AND workspace_id = ${ctx.workspaceId} AND deleted_at IS NULL FOR UPDATE`, db);
      if (!keep) throw conflict(`The kept ${entity} no longer exists`);
      if (new Date(keep.updated_at) > new Date(m.created_at)) {
        throw conflict(`“${titleOf(entity, keep)}” was changed after the merge, so the merge can’t be undone automatically`);
      }
      assertOnRecord(ctx, entity, 'edit', keep);
      for (const M of Ms) {
        const g = await q1<Row & { deleted_at: Date | null; merged_into_id: number | null }>(sql`SELECT * FROM ${table} WHERE id = ${M} AND workspace_id = ${ctx.workspaceId} FOR UPDATE`, db);
        if (!g || !g.deleted_at || Number(g.merged_into_id) !== S) throw conflict(`“${snap.titles?.[M] ?? `#${M}`}” was restored or merged somewhere else since`);
        assertOnRecord(ctx, entity, 'delete', g);
      }

      // Kept record: its field values before the merge.
      const restoreCols = [...new Set([...MERGE_FIELDS[entity].flatMap((f) => f.cols), 'custom', ...(entity === 'contact' ? ['primary_company_id'] : [])])];
      await updateRow(db, TABLE[entity], S, ctx.workspaceId, { ...Object.fromEntries(restoreCols.map((c) => [c, colValue(snap.survivor[c])])), updated_by: ctx.userId });

      // Contact details of all of them, exactly as they were (same ids).
      await q(sql`DELETE FROM contact_methods WHERE party_type = ${entity} AND party_id = ANY(${[S, ...Ms]})`, db);
      for (const row of snap.methods) {
        const cols = Object.keys(row);
        await q(sql`INSERT INTO contact_methods (${raw(cols.join(', '))}) OVERRIDING SYSTEM VALUE VALUES (${join(cols.map((c) => sql`${colValue(row[c])}`))})`, db);
      }

      // Links: give each merged record its links back; remove the kept record's copies it didn't have before.
      const before = (rows: Record<string, unknown>[], key: string, owner: string, id: number) => new Set(rows.filter((r) => Number(r[owner]) === id).map((r) => Number(r[key])));
      const sActs = before(snap.activityLinks, 'activity_id', 'entity_id', S);
      for (const l of snap.activityLinks.filter((r) => Number(r.entity_id) !== S)) {
        await q(sql`INSERT INTO activity_links (activity_id, entity_type, entity_id) VALUES (${l.activity_id as number}, ${entity}, ${l.entity_id as number}) ON CONFLICT DO NOTHING`, db);
        if (!sActs.has(Number(l.activity_id))) await q(sql`DELETE FROM activity_links WHERE activity_id = ${l.activity_id as number} AND entity_type = ${entity} AND entity_id = ${S}`, db);
      }
      if (entity === 'contact') {
        const sDeals = before(snap.dealContacts, 'deal_id', 'contact_id', S);
        for (const l of snap.dealContacts.filter((r) => Number(r.contact_id) !== S)) {
          await q(sql`INSERT INTO deal_contacts (deal_id, contact_id, is_primary) VALUES (${l.deal_id as number}, ${l.contact_id as number}, ${l.is_primary as boolean}) ON CONFLICT DO NOTHING`, db);
          if (!sDeals.has(Number(l.deal_id))) await q(sql`DELETE FROM deal_contacts WHERE deal_id = ${l.deal_id as number} AND contact_id = ${S}`, db);
        }
        for (const l of snap.dealContacts.filter((r) => Number(r.contact_id) === S)) {
          await q(sql`UPDATE deal_contacts SET is_primary = ${l.is_primary as boolean} WHERE deal_id = ${l.deal_id as number} AND contact_id = ${S}`, db);
        }
      }
      if (entity === 'contact' || entity === 'company') {
        const [own, other] = entity === 'contact' ? ['contact_id', 'company_id'] : ['company_id', 'contact_id'];
        const sOther = before(snap.contactCompanies, other, own, S);
        for (const l of snap.contactCompanies.filter((r) => Number(r[own]) !== S)) {
          await q(sql`INSERT INTO contact_companies (contact_id, company_id, role) VALUES (${l.contact_id as number}, ${l.company_id as number}, ${(l.role as string | null) ?? null}) ON CONFLICT DO NOTHING`, db);
          if (!sOther.has(Number(l[other]))) await q(sql`DELETE FROM contact_companies WHERE ${raw(own)} = ${S} AND ${raw(other)} = ${l[other] as number}`, db);
        }
      }

      // Moved rows go back to the record they came from (only rows that are still on the kept record).
      for (const M of Ms) {
        const mv = snap.moved[M] ?? {};
        const back = async (key: string, f: (idList: number[]) => Fragment) => { if (mv[key]?.length) await q(f(mv[key]), db); };
        await back('notes', (l) => sql`UPDATE notes SET entity_id = ${M} WHERE id = ANY(${l}) AND entity_id = ${S}`);
        await back('attachments', (l) => sql`UPDATE attachments SET entity_id = ${M} WHERE id = ANY(${l}) AND entity_id = ${S}`);
        await back('notifications', (l) => sql`UPDATE notifications SET entity_id = ${M} WHERE id = ANY(${l}) AND entity_id = ${S}`);
        await back('audit', (l) => sql`UPDATE audit_events SET entity_id = ${M}, changes = changes - '_from' WHERE id = ANY(${l}) AND entity_id = ${S}`);
        await back('dealsCompany', (l) => sql`UPDATE deals SET company_id = ${M} WHERE id = ANY(${l}) AND company_id = ${S}`);
        await back('contactsPrimary', (l) => sql`UPDATE contacts SET primary_company_id = ${M} WHERE id = ANY(${l}) AND primary_company_id = ${S}`);
        await back('leadsConvertedContact', (l) => sql`UPDATE leads SET converted_contact_id = ${M} WHERE id = ANY(${l}) AND converted_contact_id = ${S}`);
        await back('leadsConvertedCompany', (l) => sql`UPDATE leads SET converted_company_id = ${M} WHERE id = ANY(${l}) AND converted_company_id = ${S}`);
        await back('dealsLead', (l) => sql`UPDATE deals SET lead_id = ${M} WHERE id = ANY(${l}) AND lead_id = ${S}`);
        await back('lineItems', (l) => sql`UPDATE line_items SET parent_id = ${M}, sort = sort - 1000 WHERE id = ANY(${l}) AND parent_type = 'lead' AND parent_id = ${S}`);
        await back('previouslyMerged', (l) => sql`UPDATE ${table} SET merged_into_id = ${M} WHERE id = ANY(${l}) AND merged_into_id = ${S}`);
        await q(sql`UPDATE ${table} SET deleted_at = NULL, deleted_by = NULL, merged_into_id = NULL WHERE id = ${M}`, db);
        await audit(db, ctx, entity, M, 'merge_undone', { from: { id: S, name: titleOf(entity, keep) } });
      }
      await audit(db, ctx, entity, S, 'merge_undone', { restored: Ms.map((id) => ({ id, name: snap.titles?.[id] ?? null })) });
      await q(sql`UPDATE merge_snapshots SET undone_at = now(), undone_by = ${ctx.userId} WHERE id = ${m.id}`, db);
      return { id: S, restoredIds: Ms };
    });
  });
}

/** JSON snapshot values back to SQL parameters (objects such as address and custom stay JSON). */
function colValue(v: unknown): unknown {
  return v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v;
}

/** For detail endpoints: a 404 that tells the client where a merged record went. */
export async function mergedOr404(ctx: Ctx, entity: Entity, id: number): Promise<never> {
  const r = await q1<{ merged_into_id: number | null }>(sql`SELECT merged_into_id FROM ${raw(TABLE[entity])}
    WHERE id = ${id} AND workspace_id = ${ctx.workspaceId} AND deleted_at IS NOT NULL`);
  let target = r?.merged_into_id ?? null;
  // Follow the chain to a live record (A → B → C when B was merged later).
  for (let i = 0; target && i < 10; i++) {
    const next = await q1<{ merged_into_id: number | null; deleted_at: Date | null }>(sql`SELECT merged_into_id, deleted_at FROM ${raw(TABLE[entity])} WHERE id = ${target}`);
    if (!next?.deleted_at) break;
    target = next.merged_into_id;
  }
  if (target) throw new AppError(404, 'MERGED', `This ${entity} was merged into another one`, undefined, { mergedIntoId: target });
  throw notFound(NOUN[entity]);
}
