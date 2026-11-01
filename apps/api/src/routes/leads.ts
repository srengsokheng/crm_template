import type { FastifyInstance } from 'fastify';
import {
  convertLeadSchema, disqualifySchema, leadCreateSchema, leadUpdateSchema, lineItemsSchema, listQuerySchema, moveSchema, personName,
} from '@crm/shared';
import { and, pool, q, q1, sql, tx, type Db } from '../db/index.ts';
import { audit, diff } from '../lib/audit.ts';
import { copyMethods, findDuplicates, loadMethods, replaceMethods } from '../lib/contactMethods.ts';
import type { Ctx } from '../lib/context.ts';
import { assertRequired, loadDefs, mergeCustom, missingRequired } from '../lib/customFields.ts';
import { badRequest } from '../lib/errors.ts';
import { emit } from '../lib/events.ts';
import { ctxOf } from '../lib/http.ts';
import { likeTerm, qs, runList } from '../lib/list.ts';
import { assertOnRecord, requireAny, scopeWhere } from '../lib/permissions.ts';
import { assertMembers, assertRefs, camel, camelAll, getActive, insertRow, pickColumns, updateRow } from '../lib/records.ts';
import { getStage, recordStageChange, resolvePipelineStage, stageOfKind, type MoveInput } from '../lib/stages.ts';
import { parse } from '../lib/validate.ts';
import { createDeal, loadLineItems, replaceLineItems } from './deals.ts';

type IdParams = { Params: { id: string } };
type LeadRow = Record<string, unknown> & {
  id: number; title: string; owner_id: number; visibility: string; custom: Record<string, unknown>; stage_id: number; pipeline_id: number;
  status: string; first_name: string | null; last_name: string | null; job_title: string | null; company_name: string | null;
  source_id: number | null; amount: string | null; currency: string; address: unknown; description: string | null;
};

const LEAD_COLS: Record<string, string> = {
  title: 'title', firstName: 'first_name', lastName: 'last_name', jobTitle: 'job_title', companyName: 'company_name',
  sourceId: 'source_id', sourceDetails: 'source_details', amount: 'amount', currency: 'currency', address: 'address',
  description: 'description', ownerId: 'owner_id', visibility: 'visibility',
};

const autoTitle = (b: { title?: string | null; companyName?: string | null; firstName?: string | null; lastName?: string | null; methods?: { value: string }[] }) =>
  b.title || b.companyName || personName(b.firstName, b.lastName) || b.methods?.[0]?.value || 'New lead';

function leadFilters(ctx: Ctx, query: Record<string, unknown>) {
  const owner = query.ownerId === 'me' ? ctx.userId : qs.id(query.ownerId);
  const status = qs.str(query.status);
  return [
    sql`l.workspace_id = ${ctx.workspaceId}`, sql`l.deleted_at IS NULL`, scopeWhere(ctx, 'lead', 'view', 'l'),
    owner ? sql`l.owner_id = ${owner}` : null,
    qs.id(query.pipelineId) ? sql`l.pipeline_id = ${qs.id(query.pipelineId)}` : null,
    qs.ids(query.stageId) ? sql`l.stage_id = ANY(${qs.ids(query.stageId)})` : null,
    status && ['open', 'won', 'lost'].includes(status) ? sql`l.status = ${status}` : null,
    qs.id(query.sourceId) ? sql`l.source_id = ${qs.id(query.sourceId)}` : null,
    qs.date(query.createdFrom) ? sql`l.created_at >= ${qs.date(query.createdFrom)}::date` : null,
    qs.date(query.createdTo) ? sql`l.created_at < ${qs.date(query.createdTo)}::date + 1` : null,
  ];
}
const leadSearch = (t: string) => sql`((l.title || ' ' || coalesce(l.first_name,'') || ' ' || coalesce(l.last_name,'') || ' ' || coalesce(l.company_name,'')) ILIKE ${likeTerm(t)}
  OR EXISTS (SELECT 1 FROM contact_methods cm WHERE cm.party_type = 'lead' AND cm.party_id = l.id AND (cm.normalized ILIKE ${likeTerm(t.toLowerCase())} OR cm.value ILIKE ${likeTerm(t)})))`;
const LEAD_SELECT = sql`l.id, l.title, l.first_name, l.last_name, l.company_name, l.amount, l.currency, l.status, l.stage_id, l.pipeline_id,
  l.source_id, l.owner_id, l.created_at, l.updated_at, l.stage_changed_at, l.converted_deal_id,
  u.name AS owner_name, s.name AS stage_name, s.color AS stage_color, src.label AS source_name,
  (SELECT value FROM contact_methods cm WHERE cm.party_type = 'lead' AND cm.party_id = l.id AND cm.kind = 'email' ORDER BY is_primary DESC, sort LIMIT 1) AS email,
  (SELECT value FROM contact_methods cm WHERE cm.party_type = 'lead' AND cm.party_id = l.id AND cm.kind = 'phone' ORDER BY is_primary DESC, sort LIMIT 1) AS phone,
  (SELECT json_build_object('id', a.id, 'subject', a.subject, 'dueAt', a.due_at, 'kind', a.kind) FROM activity_links al
     JOIN activities a ON a.id = al.activity_id AND a.status = 'open' AND a.deleted_at IS NULL
     WHERE al.entity_type = 'lead' AND al.entity_id = l.id ORDER BY a.due_at NULLS LAST LIMIT 1) AS next_activity`;
const LEAD_FROM = sql`leads l JOIN stages s ON s.id = l.stage_id LEFT JOIN users u ON u.id = l.owner_id LEFT JOIN dictionary_items src ON src.id = l.source_id`;

export async function moveLead(db: Db, ctx: Ctx, id: number, input: MoveInput, opts: { checkPermission?: boolean } = {}): Promise<LeadRow> {
  const before = await getActive<LeadRow>(db, 'leads', id, ctx, 'Lead');
  if (opts.checkPermission !== false) assertOnRecord(ctx, 'lead', 'edit', before);
  const to = await getStage(db, ctx, input.stageId);
  if (to.entity_type !== 'lead' || to.pipeline_id !== before.pipeline_id) throw badRequest('Stage is not in this lead pipeline', { stageId: 'Invalid stage' });
  if (to.kind === 'won') throw badRequest('Use "Convert" to move a lead to a converted stage', { stageId: 'Convert instead' });
  if (before.status === 'won') throw badRequest('This lead is already converted');
  if (to.id === before.stage_id) return before;
  const from = await getStage(db, ctx, before.stage_id);
  const defs = await loadDefs(ctx.workspaceId, 'lead', db);
  const custom = mergeCustom(defs, input.custom, before.custom);
  await assertRequired(defs, custom, to.id);
  const row = (await updateRow(db, 'leads', id, ctx.workspaceId, {
    stage_id: to.id, status: to.kind, custom, stage_changed_at: new Date(), stage_changed_by: ctx.roleName === 'system' ? null : ctx.userId,
    disqualify_reason_id: to.kind === 'lost' ? (input.lostReasonId ?? null) : null, updated_by: ctx.userId,
  })) as LeadRow;
  await recordStageChange(db, ctx, 'lead', id, from, to);
  return row;
}

export async function leadRoutes(app: FastifyInstance) {
  app.get('/leads', async (req) => {
    const ctx = ctxOf(req);
    requireAny(ctx, 'lead', 'view');
    const query = parse(listQuerySchema, req.query);
    const r = await runList({
      select: LEAD_SELECT, from: LEAD_FROM, where: leadFilters(ctx, query), search: leadSearch,
      sorts: { title: 'lower(l.title)', amount: 'l.amount', stage: 's.sort', owner: 'u.name', source: 'src.label', createdAt: 'l.created_at', updatedAt: 'l.updated_at' },
      defaultSort: '-createdAt',
      aggregates: sql`coalesce(sum(l.amount), 0)::text AS amount_sum`,
    }, query);
    return { ...r, data: camelAll(r.data as Record<string, unknown>[]) };
  });

  app.get('/leads/board', async (req) => {
    const ctx = ctxOf(req);
    requireAny(ctx, 'lead', 'view');
    const query = req.query as Record<string, string>;
    const pipelineId = qs.id(query.pipelineId) ?? (await resolvePipelineStage(pool, ctx, 'lead')).pipeline_id;
    const limit = Math.min(qs.id(query.limit) ?? 50, 200);
    const where = and([...leadFilters(ctx, { ...query, pipelineId: String(pipelineId) }), query.q ? leadSearch(query.q) : null]);
    const stats = await q(sql`SELECT l.stage_id, count(*)::int AS count, coalesce(sum(l.amount),0)::text AS sum FROM ${LEAD_FROM} WHERE ${where} GROUP BY l.stage_id`);
    const rows = await q(sql`SELECT * FROM (SELECT ${LEAD_SELECT}, row_number() OVER (PARTITION BY l.stage_id ORDER BY l.stage_changed_at DESC, l.id DESC) AS rn
      FROM ${LEAD_FROM} WHERE ${where}) x WHERE rn <= ${limit}`);
    return { pipelineId, stats: camelAll(stats), leads: camelAll(rows) };
  });

  app.get<IdParams>('/leads/:id', async (req) => {
    const ctx = ctxOf(req);
    const id = Number(req.params.id);
    const row = await getActive<LeadRow>(pool, 'leads', id, ctx, 'Lead');
    assertOnRecord(ctx, 'lead', 'view', row);
    const [methods, items, owner, converted] = await Promise.all([
      loadMethods('lead', [id]), loadLineItems('lead', id),
      q1(sql`SELECT id, name FROM users WHERE id = ${row.owner_id}`),
      q1(sql`SELECT
        (SELECT json_build_object('id', id, 'title', title) FROM deals WHERE id = ${row.converted_deal_id as number | null}) AS deal,
        (SELECT json_build_object('id', id, 'name', trim(coalesce(first_name,'') || ' ' || coalesce(last_name,''))) FROM contacts WHERE id = ${row.converted_contact_id as number | null}) AS contact,
        (SELECT json_build_object('id', id, 'name', name) FROM companies WHERE id = ${row.converted_company_id as number | null}) AS company`),
    ]);
    return { ...camel(row), methods: methods[id] ?? [], lineItems: items, owner: camel(owner), converted };
  });

  app.post('/leads', async (req, reply) => {
    const ctx = ctxOf(req);
    requireAny(ctx, 'lead', 'create');
    const body = parse(leadCreateSchema, req.body);
    await assertRefs(ctx, [{ table: 'dictionary_items', ids: [body.sourceId], label: 'Source', kind: 'lead_source' }]);
    await assertMembers(ctx, [body.ownerId]);
    const row = await tx(async (db) => {
      const stage = await resolvePipelineStage(db, ctx, 'lead', body.pipelineId, body.stageId);
      if (stage.kind !== 'open') throw badRequest('New leads must start in an open stage', { stageId: 'Choose an open stage' });
      const defs = await loadDefs(ctx.workspaceId, 'lead', db);
      const custom = mergeCustom(defs, body.custom);
      await assertRequired(defs, custom, stage.id);
      const r = (await insertRow(db, 'leads', {
        ...pickColumns(body, LEAD_COLS), title: autoTitle(body), currency: body.currency ?? ctx.baseCurrency,
        pipeline_id: stage.pipeline_id, stage_id: stage.id, status: 'open', workspace_id: ctx.workspaceId,
        owner_id: body.ownerId ?? ctx.userId, custom, created_by: ctx.userId, updated_by: ctx.userId, stage_changed_by: ctx.userId,
      })) as LeadRow;
      await replaceMethods(db, ctx.workspaceId, 'lead', r.id, body.methods);
      await recordStageChange(db, ctx, 'lead', r.id, null, stage, { title: r.title });
      await emit(db, ctx.workspaceId, 'lead.created', 'lead', r.id, { stageId: stage.id }, ctx.depth ?? 0);
      return r;
    });
    return reply.code(201).send(camel(row));
  });

  app.patch<IdParams>('/leads/:id', async (req) => {
    const ctx = ctxOf(req);
    const id = Number(req.params.id);
    const body = parse(leadUpdateSchema, req.body);
    return tx(async (db) => {
      const before = await getActive<LeadRow>(db, 'leads', id, ctx, 'Lead');
      assertOnRecord(ctx, 'lead', 'edit', before);
      await assertRefs(ctx, [{ table: 'dictionary_items', ids: [body.sourceId], label: 'Source', kind: 'lead_source' }], db);
      await assertMembers(ctx, [body.ownerId], db);
      const values = pickColumns(body, LEAD_COLS);
      if ('title' in values && !values.title) values.title = autoTitle({ ...camel<Record<string, unknown>>(before), ...body } as never);
      if (body.custom !== undefined) {
        const defs = await loadDefs(ctx.workspaceId, 'lead', db);
        values.custom = mergeCustom(defs, body.custom, before.custom);
        await assertRequired(defs, values.custom as Record<string, unknown>, before.stage_id);
      }
      const changes = diff(before, values);
      let row = await updateRow(db, 'leads', id, ctx.workspaceId, { ...values, updated_by: ctx.userId }, { version: body.version });
      await replaceMethods(db, ctx.workspaceId, 'lead', id, body.methods);
      if (body.methods) changes.methods = [null, body.methods.map((m) => m.value)];
      if (Object.keys(changes).length) await audit(db, ctx, 'lead', id, 'updated', changes);
      if (body.stageId && body.stageId !== before.stage_id) row = await moveLead(db, ctx, id, { stageId: body.stageId });
      return camel(row);
    });
  });

  app.post<IdParams>('/leads/:id/move', async (req) => {
    const ctx = ctxOf(req);
    const body = parse(moveSchema, req.body);
    return camel(await tx((db) => moveLead(db, ctx, Number(req.params.id), body)));
  });

  app.post<IdParams>('/leads/:id/disqualify', async (req) => {
    const ctx = ctxOf(req);
    const id = Number(req.params.id);
    const body = parse(disqualifySchema, req.body);
    return camel(await tx(async (db) => {
      const lead = await getActive<LeadRow>(db, 'leads', id, ctx, 'Lead');
      const stage = body.stageId ? await getStage(db, ctx, body.stageId) : await stageOfKind(db, lead.pipeline_id, 'lost');
      if (!stage || stage.kind !== 'lost') throw badRequest('This pipeline has no disqualified stage');
      if (body.reasonId) await assertRefs(ctx, [{ table: 'dictionary_items', ids: [body.reasonId], label: 'Reason', kind: 'disqualify_reason' }], db);
      const row = await moveLead(db, ctx, id, { stageId: stage.id, lostReasonId: body.reasonId });
      if (body.note) await q(sql`INSERT INTO notes (workspace_id, entity_type, entity_id, body, author_id) VALUES (${ctx.workspaceId}, 'lead', ${id}, ${'Disqualified: ' + body.note}, ${ctx.userId})`, db);
      return row;
    }));
  });

  app.put<IdParams>('/leads/:id/line-items', async (req) => {
    const ctx = ctxOf(req);
    const id = Number(req.params.id);
    const body = parse(lineItemsSchema, req.body);
    return tx(async (db) => {
      const lead = await getActive<LeadRow>(db, 'leads', id, ctx, 'Lead');
      assertOnRecord(ctx, 'lead', 'edit', lead);
      await replaceLineItems(db, ctx, 'lead', id, body.items);
      await audit(db, ctx, 'lead', id, 'updated', { lineItems: [null, body.items.length] });
      return { lineItems: await loadLineItems('lead', id, db) };
    });
  });

  /** Conversion preview: duplicate suggestions for the contact and company the lead would create. */
  app.get<IdParams>('/leads/:id/convert-preview', async (req) => {
    const ctx = ctxOf(req);
    const id = Number(req.params.id);
    const lead = await getActive<LeadRow>(pool, 'leads', id, ctx, 'Lead');
    assertOnRecord(ctx, 'lead', 'view', lead);
    const methods = (await loadMethods('lead', [id]))[id] ?? [];
    const emails = methods.filter((m) => m.kind === 'email').map((m) => m.value);
    const phones = methods.filter((m) => m.kind === 'phone').map((m) => m.value);
    const hits = await findDuplicates(ctx.workspaceId, { emails, phones, name: personName(lead.first_name, lead.last_name), companyName: lead.company_name ?? undefined }, { entityType: 'lead', id });
    const defs = await loadDefs(ctx.workspaceId, 'deal');
    const dealStage = await resolvePipelineStage(pool, ctx, 'deal');
    return {
      contactName: personName(lead.first_name, lead.last_name) || null,
      companyName: lead.company_name,
      contactMatches: hits.filter((h) => h.entityType === 'contact'),
      companyMatches: hits.filter((h) => h.entityType === 'company'),
      dealDefaults: { title: lead.title, amount: lead.amount, pipelineId: dealStage.pipeline_id, stageId: dealStage.id },
      dealRequiredFields: (await missingRequired(defs, {}, dealStage.id)).map((d) => ({ key: d.key, label: d.label, type: d.type, options: d.options })),
    };
  });

  app.post<IdParams>('/leads/:id/convert', async (req) => {
    const ctx = ctxOf(req);
    const id = Number(req.params.id);
    const body = parse(convertLeadSchema, req.body);
    requireAny(ctx, 'lead', 'edit');
    const result = await tx(async (db) => {
      const lead = await getActive<LeadRow>(db, 'leads', id, ctx, 'Lead');
      assertOnRecord(ctx, 'lead', 'edit', lead);
      if (lead.status === 'won') throw badRequest('This lead was already converted');
      if (body.contact.mode === 'skip' && body.company.mode === 'skip' && !body.deal.create) throw badRequest('Choose at least one record to create or link');
      let contactId: number | null = null;
      let companyId: number | null = null;

      if (body.company.mode === 'existing') {
        await assertRefs(ctx, [{ table: 'companies', ids: [body.company.id], label: 'Company' }], db);
        companyId = body.company.id;
      } else if (body.company.mode === 'create') {
        requireAny(ctx, 'company', 'create');
        if (!lead.company_name) throw badRequest('The lead has no company name to create a company from', { company: 'No company name' });
        const c = await insertRow(db, 'companies', {
          workspace_id: ctx.workspaceId, name: lead.company_name, source_id: lead.source_id, address: lead.address, currency: lead.currency,
          owner_id: lead.owner_id, created_by: ctx.userId, updated_by: ctx.userId,
        });
        companyId = c.id as number;
        await copyMethods(db, ctx.workspaceId, 'lead', id, 'company', companyId, ['website']);
        await audit(db, ctx, 'company', companyId, 'created', { name: lead.company_name, fromLead: id });
      }

      if (body.contact.mode === 'existing') {
        await assertRefs(ctx, [{ table: 'contacts', ids: [body.contact.id], label: 'Contact' }], db);
        contactId = body.contact.id;
      } else if (body.contact.mode === 'create') {
        requireAny(ctx, 'contact', 'create');
        if (!lead.first_name && !lead.last_name) throw badRequest('The lead has no person name to create a contact from', { contact: 'No name' });
        const c = await insertRow(db, 'contacts', {
          workspace_id: ctx.workspaceId, first_name: lead.first_name, last_name: lead.last_name, job_title: lead.job_title,
          source_id: lead.source_id, address: lead.address, primary_company_id: companyId, owner_id: lead.owner_id,
          created_by: ctx.userId, updated_by: ctx.userId,
        });
        contactId = c.id as number;
        await copyMethods(db, ctx.workspaceId, 'lead', id, 'contact', contactId, ['phone', 'email', 'messenger']);
        await audit(db, ctx, 'contact', contactId, 'created', { name: personName(lead.first_name, lead.last_name), fromLead: id });
      }
      if (contactId && companyId) {
        await q(sql`INSERT INTO contact_companies (contact_id, company_id) VALUES (${contactId}, ${companyId}) ON CONFLICT DO NOTHING`, db);
        await q(sql`UPDATE contacts SET primary_company_id = coalesce(primary_company_id, ${companyId}) WHERE id = ${contactId}`, db);
      }

      let dealId: number | null = null;
      if (body.deal.create) {
        requireAny(ctx, 'deal', 'create');
        const items = await q<{ product_id: number | null; name: string; unit_price: string; quantity: string; unit: string; discount_type: 'percent' | 'amount' | null; discount_value: string; tax_rate: string | null; tax_included: boolean }>(
          sql`SELECT product_id, name, unit_price, quantity, unit, discount_type, discount_value, tax_rate, tax_included FROM line_items WHERE parent_type = 'lead' AND parent_id = ${id} ORDER BY sort`, db);
        // Copy custom field values whose keys also exist on deals.
        const dealDefs = await loadDefs(ctx.workspaceId, 'deal', db);
        const carried = Object.fromEntries(Object.entries(lead.custom ?? {}).filter(([k]) => dealDefs.some((d) => d.key === k)));
        const amount = body.deal.amount ?? (items.length ? undefined : lead.amount ?? undefined);
        const deal = await createDeal(db, ctx, {
          title: body.deal.title || lead.title, pipelineId: body.deal.pipelineId, stageId: body.deal.stageId,
          amount: amount ?? undefined, amountMode: items.length && !body.deal.amount ? 'auto' : undefined, currency: lead.currency,
          companyId, contactIds: contactId ? [contactId] : [], sourceId: lead.source_id, ownerId: lead.owner_id,
          description: lead.description, custom: { ...carried, ...(body.deal.custom ?? {}) }, leadId: id,
        });
        dealId = deal.id;
        if (items.length) {
          await replaceLineItems(db, ctx, 'deal', dealId, items.map((i) => ({
            productId: i.product_id, name: i.name, unitPrice: i.unit_price, quantity: Number(i.quantity), unit: i.unit,
            discountType: i.discount_type, discountValue: Number(i.discount_value), taxRate: i.tax_rate === null ? null : Number(i.tax_rate), taxIncluded: i.tax_included,
          })));
        }
      }

      // Re-link notes' visibility & open activities to the new records (activities keep their lead link too).
      const targets: [string, number | null][] = [['deal', dealId], ['contact', contactId], ['company', companyId]];
      for (const [type, tid] of targets) {
        if (!tid) continue;
        await q(sql`INSERT INTO activity_links (activity_id, entity_type, entity_id)
          SELECT activity_id, ${type}, ${tid} FROM activity_links WHERE entity_type = 'lead' AND entity_id = ${id} ON CONFLICT DO NOTHING`, db);
      }
      const won = await stageOfKind(db, lead.pipeline_id, 'won');
      if (!won) throw badRequest('The lead pipeline has no "converted" stage');
      const from = await getStage(db, ctx, lead.stage_id);
      await updateRow(db, 'leads', id, ctx.workspaceId, {
        stage_id: won.id, status: 'won', converted_at: new Date(), converted_contact_id: contactId, converted_company_id: companyId,
        converted_deal_id: dealId, stage_changed_at: new Date(), stage_changed_by: ctx.userId, updated_by: ctx.userId,
      });
      await recordStageChange(db, ctx, 'lead', id, from, { ...won, entity_type: 'lead' }, { dealId: [null, dealId], contactId: [null, contactId], companyId: [null, companyId] });
      return { dealId, contactId, companyId };
    });
    return result;
  });
}
