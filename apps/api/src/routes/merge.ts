/**
 * Merge two duplicate contacts or companies into one.
 *
 * The kept record ("survivor") takes the chosen field values; everything attached to the other record moves over:
 * contact details (without duplicates), deals, company/contact links, activities, notes, converted-lead links,
 * notifications and its history. The other record is soft-deleted with `merged_into_id` set, so old links can point
 * to the survivor. One transaction, both rows locked; audited as `merged` on the survivor.
 */
import type { FastifyInstance } from 'fastify';
import { MERGE_ENTITIES, mergeSchema, normalizeContactValue, personName } from '@crm/shared';
import { q, q1, raw, sql, tx, type Db } from '../db/index.ts';
import { audit } from '../lib/audit.ts';
import { loadMethods } from '../lib/contactMethods.ts';
import type { Ctx } from '../lib/context.ts';
import { loadDefs } from '../lib/customFields.ts';
import { AppError, badRequest, notFound } from '../lib/errors.ts';
import { ctxOf } from '../lib/http.ts';
import { assertOnRecord, canOnRecord } from '../lib/permissions.ts';
import { camel, camelAll, updateRow } from '../lib/records.ts';
import { parse } from '../lib/validate.ts';

type Entity = (typeof MERGE_ENTITIES)[number];
type Row = Record<string, unknown> & { id: number; owner_id: number; visibility: string; custom: Record<string, unknown>; created_at: Date };

const TABLE: Record<Entity, string> = { contact: 'contacts', company: 'companies' };

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
};

const isEmpty = (v: unknown) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)
  || (typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v) && Object.values(v as object).every((x) => x === null || x === ''));
const titleOf = (entity: Entity, r: Row) => (entity === 'contact' ? personName(r.first_name as string, r.last_name as string) : String(r.name));

function entityOf(param: string): Entity {
  if (!(MERGE_ENTITIES as readonly string[]).includes(param)) throw notFound();
  return param as Entity;
}

async function lockActive(db: Db, ctx: Ctx, entity: Entity, id: number): Promise<Row> {
  const r = await q1<Row>(sql`SELECT * FROM ${raw(TABLE[entity])} WHERE id = ${id} AND workspace_id = ${ctx.workspaceId} AND deleted_at IS NULL FOR UPDATE`, db);
  if (!r) throw notFound(entity === 'contact' ? 'Contact' : 'Company');
  return r;
}

/** Counts of what hangs off a record, shown before merging. */
async function related(db: Db, entity: Entity, id: number) {
  const r = await q1<Record<string, number>>(entity === 'contact'
    ? sql`SELECT
        (SELECT count(*)::int FROM deal_contacts dc JOIN deals d ON d.id = dc.deal_id AND d.deleted_at IS NULL WHERE dc.contact_id = ${id}) AS deals,
        (SELECT count(*)::int FROM contact_companies WHERE contact_id = ${id}) AS companies,
        (SELECT count(*)::int FROM activity_links al JOIN activities a ON a.id = al.activity_id AND a.deleted_at IS NULL WHERE al.entity_type = 'contact' AND al.entity_id = ${id}) AS activities,
        (SELECT count(*)::int FROM notes WHERE entity_type = 'contact' AND entity_id = ${id} AND deleted_at IS NULL) AS notes`
    : sql`SELECT
        (SELECT count(*)::int FROM deals WHERE company_id = ${id} AND deleted_at IS NULL) AS deals,
        (SELECT count(*)::int FROM contact_companies cc JOIN contacts c ON c.id = cc.contact_id AND c.deleted_at IS NULL WHERE cc.company_id = ${id}) AS contacts,
        (SELECT count(*)::int FROM activity_links al JOIN activities a ON a.id = al.activity_id AND a.deleted_at IS NULL WHERE al.entity_type = 'company' AND al.entity_id = ${id}) AS activities,
        (SELECT count(*)::int FROM notes WHERE entity_type = 'company' AND entity_id = ${id} AND deleted_at IS NULL) AS notes`, db);
  return r ?? {};
}

export async function mergeRoutes(app: FastifyInstance) {
  // Side-by-side comparison of two records (both must be visible to the caller).
  app.get<{ Params: { entity: string }; Querystring: { ids?: string } }>('/merge/:entity', async (req) => {
    const ctx = ctxOf(req);
    const entity = entityOf(req.params.entity);
    const ids = (req.query.ids ?? '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (ids.length !== 2 || ids[0] === ids[1]) throw badRequest('Choose two different records');
    return tx(async (db) => {
      const records = [];
      for (const id of ids) {
        const r = await q1<Row>(sql`SELECT * FROM ${raw(TABLE[entity])} WHERE id = ${id} AND workspace_id = ${ctx.workspaceId} AND deleted_at IS NULL`, db);
        if (!r) throw notFound(entity === 'contact' ? 'Contact' : 'Company');
        assertOnRecord(ctx, entity, 'view', r);
        records.push({
          ...camel(r), title: titleOf(entity, r),
          companyName: entity === 'contact' && r.primary_company_id ? (await q1<{ name: string }>(sql`SELECT name FROM companies WHERE id = ${r.primary_company_id as number}`, db))?.name ?? null : null, methods: camelAll(((await loadMethods(entity, [id], db))[id] ?? []) as unknown as Record<string, unknown>[]), related: await related(db, entity, id),
          canKeep: canOnRecord(ctx, entity, 'edit', r), canRemove: canOnRecord(ctx, entity, 'delete', r),
        });
      }
      const defs = await loadDefs(ctx.workspaceId, entity, db);
      return {
        records,
        fields: MERGE_FIELDS[entity].map(({ key, label }) => ({ key, label })),
        customFields: defs.map((d) => ({ key: d.key, label: d.label, type: d.type, options: d.options })),
      };
    });
  });

  app.post<{ Params: { entity: string } }>('/merge/:entity', async (req) => {
    const ctx = ctxOf(req);
    const entity = entityOf(req.params.entity);
    const body = parse(mergeSchema, req.body);
    if (body.survivorId === body.mergedId) throw badRequest('Choose two different records');
    const table = raw(TABLE[entity]);
    const result = await tx(async (db) => {
      // Lock in id order so two concurrent merges of the same pair can't deadlock.
      const [lo, hi] = [body.survivorId, body.mergedId].sort((a, b) => a - b);
      const locked = { [lo]: await lockActive(db, ctx, entity, lo), [hi]: await lockActive(db, ctx, entity, hi) };
      const keep = locked[body.survivorId];
      const gone = locked[body.mergedId];
      assertOnRecord(ctx, entity, 'edit', keep);
      assertOnRecord(ctx, entity, 'delete', gone);
      const S = keep.id;
      const M = gone.id;

      // ── Field values ──
      const values: Record<string, unknown> = {};
      const changes: Record<string, [unknown, unknown]> = {};
      const takeMerged = (key: string, a: unknown, b: unknown) => (body.choose[key] ?? (isEmpty(a) && !isEmpty(b) ? 'merged' : 'survivor')) === 'merged';
      for (const f of MERGE_FIELDS[entity]) {
        const a = f.cols.map((c) => keep[c]);
        const b = f.cols.map((c) => gone[c]);
        // A field is empty when its main column is (a default currency alone doesn't count as a revenue).
        if (!takeMerged(f.key, isEmpty(a[0]) ? null : a, isEmpty(b[0]) ? null : b)) continue;
        for (const c of f.cols) {
          if (JSON.stringify(keep[c] ?? null) === JSON.stringify(gone[c] ?? null)) continue;
          values[c] = gone[c] ?? null;
          changes[c] = [keep[c] ?? null, gone[c] ?? null];
        }
      }
      if (values.owner_id !== undefined) {
        const ok = await q1(sql`SELECT 1 FROM memberships WHERE workspace_id = ${ctx.workspaceId} AND user_id = ${values.owner_id as number} AND status <> 'disabled'`, db);
        if (!ok) throw badRequest('The owner of the merged record is no longer a member; keep the current owner', { ownerId: 'Inactive user' });
      }
      const custom = { ...(keep.custom ?? {}) };
      const defs = await loadDefs(ctx.workspaceId, entity, db, true);
      for (const d of defs) {
        const a = keep.custom?.[d.key];
        const b = gone.custom?.[d.key];
        if (JSON.stringify(a ?? null) === JSON.stringify(b ?? null) || !takeMerged(`custom.${d.key}`, a, b)) continue;
        if (isEmpty(b)) delete custom[d.key]; else custom[d.key] = b;
        changes[`custom.${d.key}`] = [a ?? null, b ?? null];
      }
      if (JSON.stringify(custom) !== JSON.stringify(keep.custom ?? {})) values.custom = custom;
      if (entity === 'contact' && !values.first_name && !values.last_name && !keep.first_name && !keep.last_name) {
        throw badRequest('The kept contact needs a name');
      }
      await updateRow(db, TABLE[entity], S, ctx.workspaceId, { ...values, updated_by: ctx.userId });

      // ── Contact details: add the merged record's values that the survivor doesn't have yet ──
      const have = new Set(((await loadMethods(entity, [S], db))[S] ?? []).map((m) => `${m.kind}:${normalizeContactValue(m.kind, m.value)}`));
      const primaries = new Set(((await loadMethods(entity, [S], db))[S] ?? []).filter((m) => m.is_primary).map((m) => m.kind));
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
        const primary = (values.primary_company_id ?? keep.primary_company_id) as number | null;
        if (primary) await q(sql`INSERT INTO contact_companies (contact_id, company_id) VALUES (${S}, ${primary}) ON CONFLICT DO NOTHING`, db);
        else {
          const first = await q1<{ company_id: number }>(sql`SELECT company_id FROM contact_companies WHERE contact_id = ${S} ORDER BY company_id LIMIT 1`, db);
          if (first) await q(sql`UPDATE contacts SET primary_company_id = ${first.company_id} WHERE id = ${S}`, db);
        }
        await q(sql`UPDATE leads SET converted_contact_id = ${S} WHERE workspace_id = ${ctx.workspaceId} AND converted_contact_id = ${M}`, db);
      } else {
        await q(sql`UPDATE deals SET company_id = ${S} WHERE workspace_id = ${ctx.workspaceId} AND company_id = ${M}`, db);
        await q(sql`INSERT INTO contact_companies (contact_id, company_id, role) SELECT contact_id, ${S}, role FROM contact_companies WHERE company_id = ${M}
          ON CONFLICT DO NOTHING`, db);
        await q(sql`DELETE FROM contact_companies WHERE company_id = ${M}`, db);
        await q(sql`UPDATE contacts SET primary_company_id = ${S} WHERE workspace_id = ${ctx.workspaceId} AND primary_company_id = ${M}`, db);
        await q(sql`UPDATE leads SET converted_company_id = ${S} WHERE workspace_id = ${ctx.workspaceId} AND converted_company_id = ${M}`, db);
      }
      await q(sql`INSERT INTO activity_links (activity_id, entity_type, entity_id) SELECT activity_id, entity_type, ${S} FROM activity_links
        WHERE entity_type = ${entity} AND entity_id = ${M} ON CONFLICT DO NOTHING`, db);
      await q(sql`DELETE FROM activity_links WHERE entity_type = ${entity} AND entity_id = ${M}`, db);
      await q(sql`UPDATE notes SET entity_id = ${S} WHERE workspace_id = ${ctx.workspaceId} AND entity_type = ${entity} AND entity_id = ${M}`, db);
      await q(sql`UPDATE attachments SET entity_id = ${S} WHERE workspace_id = ${ctx.workspaceId} AND entity_type = ${entity} AND entity_id = ${M}`, db);
      await q(sql`UPDATE notifications SET entity_id = ${S} WHERE workspace_id = ${ctx.workspaceId} AND entity_type = ${entity} AND entity_id = ${M}`, db);
      // History of the merged record continues on the survivor (field changes, creation, imports…).
      // Each moved event remembers which record it came from, so the timeline can say so.
      await q(sql`UPDATE audit_events SET entity_id = ${S}, changes = changes || jsonb_build_object('_from', jsonb_build_object('id', ${M}::bigint, 'name', ${titleOf(entity, gone)}::text))
        WHERE workspace_id = ${ctx.workspaceId} AND entity_type = ${entity} AND entity_id = ${M}`, db);

      // ── Retire the merged record ──
      await q(sql`UPDATE ${table} SET deleted_at = now(), deleted_by = ${ctx.userId}, merged_into_id = ${S} WHERE id = ${M}`, db);
      // Records previously merged into M now point at S.
      await q(sql`UPDATE ${table} SET merged_into_id = ${S} WHERE workspace_id = ${ctx.workspaceId} AND merged_into_id = ${M}`, db);

      const name = titleOf(entity, gone);
      await audit(db, ctx, entity, S, 'merged', { merged: { id: M, name }, ...changes, movedMethods });
      await audit(db, ctx, entity, M, 'merged_into', { into: { id: S, name: titleOf(entity, { ...keep, ...values } as Row) } });
      return { id: S, mergedId: M };
    });
    return result;
  });
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
  throw notFound(entity === 'contact' ? 'Contact' : 'Company');
}
