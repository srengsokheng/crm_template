import type { FastifyInstance } from 'fastify';
import {
  calcLine, calcTotals, closeDealSchema, dealCreateSchema, dealUpdateSchema, lineItemsSchema, listQuerySchema, moveSchema,
} from '@crm/shared';
import type { z } from 'zod';
import { and, pool, q, q1, sql, tx, type Db } from '../db/index.ts';
import { audit, diff } from '../lib/audit.ts';
import { loadMethods } from '../lib/contactMethods.ts';
import type { Ctx } from '../lib/context.ts';
import { assertRequired, loadDefs, mergeCustom } from '../lib/customFields.ts';
import { badRequest } from '../lib/errors.ts';
import { emit } from '../lib/events.ts';
import { ctxOf } from '../lib/http.ts';
import { likeTerm, qs, runList } from '../lib/list.ts';
import { assertOnRecord, requireAny, scopeWhere } from '../lib/permissions.ts';
import { assertMembers, assertRefs, camel, camelAll, getActive, insertRow, pickColumns, updateRow } from '../lib/records.ts';
import { getStage, recordStageChange, resolvePipelineStage, stageOfKind, type MoveInput, type StageRow } from '../lib/stages.ts';
import { parse } from '../lib/validate.ts';

type IdParams = { Params: { id: string } };
type DealRow = Record<string, unknown> & {
  id: number; owner_id: number; visibility: string; custom: Record<string, unknown>; stage_id: number; pipeline_id: number;
  status: string; amount: string; amount_mode: string; title: string; previous_stage_id: number | null;
};

const DEAL_COLS: Record<string, string> = {
  title: 'title', amount: 'amount', currency: 'currency', amountMode: 'amount_mode', probability: 'probability',
  expectedCloseDate: 'expected_close_date', companyId: 'company_id', dealTypeId: 'deal_type_id', sourceId: 'source_id',
  description: 'description', ownerId: 'owner_id', visibility: 'visibility',
};

async function setDealContacts(db: Db, dealId: number, contactIds: number[] | undefined) {
  if (contactIds === undefined) return;
  await q(sql`DELETE FROM deal_contacts WHERE deal_id = ${dealId}`, db);
  let first = true;
  for (const c of Array.from(new Set(contactIds))) {
    await q(sql`INSERT INTO deal_contacts (deal_id, contact_id, is_primary) VALUES (${dealId}, ${c}, ${first})`, db);
    first = false;
  }
}

export async function createDeal(db: Db, ctx: Ctx, body: z.output<typeof dealCreateSchema> & { leadId?: number | null }): Promise<DealRow> {
  await assertRefs(ctx, [
    { table: 'companies', ids: [body.companyId], label: 'Company' },
    { table: 'contacts', ids: body.contactIds ?? [], label: 'Contact' },
    { table: 'dictionary_items', ids: [body.dealTypeId, body.sourceId], label: 'Option' },
  ], db);
  await assertMembers(ctx, [body.ownerId], db);
  const stage = await resolvePipelineStage(db, ctx, 'deal', body.pipelineId, body.stageId);
  const defs = await loadDefs(ctx.workspaceId, 'deal', db);
  const custom = mergeCustom(defs, body.custom);
  await assertRequired(defs, custom, stage.id);
  const row = (await insertRow(db, 'deals', {
    ...pickColumns(body, DEAL_COLS),
    amount: body.amount ?? '0',
    amount_mode: body.amountMode ?? (body.amount && Number(body.amount) > 0 ? 'manual' : 'auto'),
    currency: body.currency ?? ctx.baseCurrency,
    probability: body.probability ?? stage.probability,
    status: stage.kind,
    closed_at: stage.kind === 'open' ? null : new Date(),
    pipeline_id: stage.pipeline_id, stage_id: stage.id, workspace_id: ctx.workspaceId, lead_id: body.leadId ?? null,
    owner_id: body.ownerId ?? ctx.userId, custom, created_by: ctx.userId, updated_by: ctx.userId, stage_changed_by: ctx.userId,
  })) as DealRow;
  await setDealContacts(db, row.id, body.contactIds);
  await recordStageChange(db, ctx, 'deal', row.id, null, stage, { title: row.title, amount: row.amount });
  await emit(db, ctx.workspaceId, 'deal.created', 'deal', row.id, { stageId: stage.id }, ctx.depth ?? 0);
  return row;
}

export async function moveDeal(db: Db, ctx: Ctx, id: number, input: MoveInput, opts: { checkPermission?: boolean } = {}): Promise<DealRow> {
  const before = await getActive<DealRow>(db, 'deals', id, ctx, 'Deal');
  if (opts.checkPermission !== false) assertOnRecord(ctx, 'deal', 'edit', before);
  const to = await getStage(db, ctx, input.stageId);
  if (to.entity_type !== 'deal' || to.pipeline_id !== before.pipeline_id) throw badRequest('Stage is not in this deal\'s pipeline', { stageId: 'Invalid stage' });
  if (to.id === before.stage_id && !input.custom) return before;
  const from = await getStage(db, ctx, before.stage_id);
  const defs = await loadDefs(ctx.workspaceId, 'deal', db);
  const custom = mergeCustom(defs, input.custom, before.custom);
  await assertRequired(defs, custom, to.id);
  if (to.kind === 'lost' && input.lostReasonId) await assertRefs(ctx, [{ table: 'dictionary_items', ids: [input.lostReasonId], label: 'Lost reason', kind: 'lost_reason' }], db);
  if (to.id === before.stage_id) {
    return (await updateRow(db, 'deals', id, ctx.workspaceId, { custom, updated_by: ctx.userId })) as DealRow;
  }
  const row = (await updateRow(db, 'deals', id, ctx.workspaceId, {
    stage_id: to.id, previous_stage_id: from.id, status: to.kind, custom,
    probability: to.probability ?? before.probability ?? null,
    closed_at: to.kind === 'open' ? null : new Date(),
    lost_reason_id: to.kind === 'lost' ? (input.lostReasonId ?? null) : null,
    lost_note: to.kind === 'lost' ? (input.lostNote ?? null) : null,
    stage_changed_at: new Date(), stage_changed_by: ctx.roleName === 'system' ? null : ctx.userId, updated_by: ctx.userId,
  })) as DealRow;
  const extra: Record<string, unknown> = {};
  if (to.kind === 'lost' && input.lostReasonId) {
    const r = await q1<{ label: string }>(sql`SELECT label FROM dictionary_items WHERE id = ${input.lostReasonId}`, db);
    extra.lostReason = [null, r?.label ?? null];
  }
  const customChanges = diff(before.custom ?? {}, custom);
  if (Object.keys(customChanges).length) extra.custom = [before.custom, custom];
  await recordStageChange(db, ctx, 'deal', id, from, to, extra);
  return row;
}

async function recalcDealAmount(db: Db, ctx: Ctx, dealId: number): Promise<void> {
  const items = await q<{ unit_price: string; quantity: string; discount_type: 'percent' | 'amount' | null; discount_value: string; tax_rate: string | null; tax_included: boolean }>(
    sql`SELECT unit_price, quantity, discount_type, discount_value, tax_rate, tax_included FROM line_items WHERE parent_type = 'deal' AND parent_id = ${dealId}`, db);
  const totals = calcTotals(items.map((i) => ({ unitPrice: i.unit_price, quantity: i.quantity, discountType: i.discount_type, discountValue: i.discount_value, taxRate: i.tax_rate, taxIncluded: i.tax_included })));
  await q(sql`UPDATE deals SET amount = ${totals.total}, updated_at = now() WHERE id = ${dealId} AND workspace_id = ${ctx.workspaceId} AND amount_mode = 'auto'`, db);
}

export async function replaceLineItems(db: Db, ctx: Ctx, parentType: 'deal' | 'lead', parentId: number, items: z.output<typeof lineItemsSchema>['items']): Promise<void> {
  await assertRefs(ctx, [{ table: 'products', ids: items.map((i) => i.productId), label: 'Product' }], db);
  await q(sql`DELETE FROM line_items WHERE parent_type = ${parentType} AND parent_id = ${parentId}`, db);
  let sort = 0;
  for (const i of items) {
    const r = calcLine({ unitPrice: i.unitPrice, quantity: i.quantity, discountType: i.discountType, discountValue: i.discountValue, taxRate: i.taxRate, taxIncluded: i.taxIncluded });
    await q(sql`INSERT INTO line_items (workspace_id, parent_type, parent_id, product_id, name, unit_price, quantity, unit, discount_type, discount_value, tax_rate, tax_included, line_total, sort)
      VALUES (${ctx.workspaceId}, ${parentType}, ${parentId}, ${i.productId ?? null}, ${i.name}, ${i.unitPrice}, ${i.quantity}, ${i.unit},
              ${i.discountType ?? null}, ${i.discountValue ?? 0}, ${i.taxRate ?? null}, ${i.taxIncluded ?? false}, ${r.lineTotal}, ${sort++})`, db);
  }
  if (parentType === 'deal') await recalcDealAmount(db, ctx, parentId);
}

export async function loadLineItems(parentType: string, parentId: number, db: Db = pool) {
  return camelAll(await q(sql`SELECT id, product_id, name, unit_price, quantity, unit, discount_type, discount_value, tax_rate, tax_included, line_total, sort
    FROM line_items WHERE parent_type = ${parentType} AND parent_id = ${parentId} ORDER BY sort, id`, db));
}

function dealFilters(ctx: Ctx, query: Record<string, unknown>) {
  const owner = query.ownerId === 'me' ? ctx.userId : qs.id(query.ownerId);
  const status = qs.str(query.status);
  return [
    sql`d.workspace_id = ${ctx.workspaceId}`, sql`d.deleted_at IS NULL`, scopeWhere(ctx, 'deal', 'view', 'd'),
    owner ? sql`d.owner_id = ${owner}` : null,
    qs.id(query.pipelineId) ? sql`d.pipeline_id = ${qs.id(query.pipelineId)}` : null,
    qs.ids(query.stageId) ? sql`d.stage_id = ANY(${qs.ids(query.stageId)})` : null,
    status && ['open', 'won', 'lost'].includes(status) ? sql`d.status = ${status}` : null,
    qs.id(query.companyId) ? sql`d.company_id = ${qs.id(query.companyId)}` : null,
    qs.id(query.contactId) ? sql`EXISTS (SELECT 1 FROM deal_contacts dc WHERE dc.deal_id = d.id AND dc.contact_id = ${qs.id(query.contactId)})` : null,
    qs.date(query.closeFrom) ? sql`d.expected_close_date >= ${qs.date(query.closeFrom)}::date` : null,
    qs.date(query.closeTo) ? sql`d.expected_close_date <= ${qs.date(query.closeTo)}::date` : null,
    query.noNextStep === '1' ? sql`NOT EXISTS (SELECT 1 FROM activity_links al JOIN activities a ON a.id = al.activity_id
       WHERE al.entity_type = 'deal' AND al.entity_id = d.id AND a.status = 'open' AND a.deleted_at IS NULL)` : null,
  ];
}

const dealSearch = (t: string) => sql`(d.title ILIKE ${likeTerm(t)} OR co.name ILIKE ${likeTerm(t)} OR EXISTS (
  SELECT 1 FROM deal_contacts dc JOIN contacts c ON c.id = dc.contact_id WHERE dc.deal_id = d.id
  AND (coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')) ILIKE ${likeTerm(t)}))`;

const DEAL_SELECT = sql`d.id, d.title, d.amount, d.currency, d.status, d.stage_id, d.pipeline_id, d.probability, d.expected_close_date,
  d.closed_at, d.owner_id, d.company_id, d.created_at, d.updated_at, d.stage_changed_at, d.amount_mode,
  co.name AS company_name, u.name AS owner_name, s.name AS stage_name, s.color AS stage_color, s.rot_days,
  (SELECT trim(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')) FROM deal_contacts dc JOIN contacts c ON c.id = dc.contact_id
     WHERE dc.deal_id = d.id ORDER BY dc.is_primary DESC LIMIT 1) AS contact_name,
  (SELECT json_build_object('id', a.id, 'subject', a.subject, 'dueAt', a.due_at, 'kind', a.kind) FROM activity_links al
     JOIN activities a ON a.id = al.activity_id AND a.status = 'open' AND a.deleted_at IS NULL
     WHERE al.entity_type = 'deal' AND al.entity_id = d.id ORDER BY a.due_at NULLS LAST LIMIT 1) AS next_activity`;
const DEAL_FROM = sql`deals d JOIN stages s ON s.id = d.stage_id LEFT JOIN companies co ON co.id = d.company_id LEFT JOIN users u ON u.id = d.owner_id`;

export async function dealRoutes(app: FastifyInstance) {
  app.get('/deals', async (req) => {
    const ctx = ctxOf(req);
    requireAny(ctx, 'deal', 'view');
    const query = parse(listQuerySchema, req.query);
    const r = await runList({
      select: DEAL_SELECT, from: DEAL_FROM, where: dealFilters(ctx, query), search: dealSearch,
      sorts: { title: 'lower(d.title)', amount: 'd.amount', stage: 's.sort', owner: 'u.name', company: 'lower(co.name)', expectedCloseDate: 'd.expected_close_date', createdAt: 'd.created_at', updatedAt: 'd.updated_at' },
      defaultSort: '-createdAt',
      aggregates: sql`coalesce(sum(d.amount), 0)::text AS amount_sum`,
    }, query);
    return { ...r, data: camelAll(r.data as Record<string, unknown>[]) };
  });

  /** Kanban board for one pipeline: every stage with count, sum and the first N cards. */
  app.get('/deals/board', async (req) => {
    const ctx = ctxOf(req);
    requireAny(ctx, 'deal', 'view');
    const query = req.query as Record<string, string>;
    const pipelineId = qs.id(query.pipelineId) ?? (await resolvePipelineStage(pool, ctx, 'deal')).pipeline_id;
    const limit = Math.min(qs.id(query.limit) ?? 50, 200);
    const where = [...dealFilters(ctx, { ...query, pipelineId: String(pipelineId) }), query.q ? dealSearch(query.q) : null].filter(Boolean);
    const stats = await q<{ stage_id: number; count: number; sum: string }>(sql`SELECT d.stage_id, count(*)::int AS count, coalesce(sum(d.amount),0)::text AS sum
      FROM ${DEAL_FROM} WHERE ${and(where)} GROUP BY d.stage_id`);
    const rows = await q(sql`SELECT * FROM (
        SELECT ${DEAL_SELECT}, row_number() OVER (PARTITION BY d.stage_id ORDER BY d.stage_changed_at DESC, d.id DESC) AS rn
        FROM ${DEAL_FROM} WHERE ${and(where)}) x WHERE rn <= ${limit}`);
    return { pipelineId, stats: camelAll(stats), deals: camelAll(rows) };
  });

  app.get<IdParams>('/deals/:id', async (req) => {
    const ctx = ctxOf(req);
    const id = Number(req.params.id);
    const row = await getActive<DealRow>(pool, 'deals', id, ctx, 'Deal');
    assertOnRecord(ctx, 'deal', 'view', row);
    const [contacts, company, items, owner, lead, lostReason] = await Promise.all([
      q<{ id: number }>(sql`SELECT c.id, c.first_name, c.last_name, c.job_title, dc.is_primary FROM deal_contacts dc
        JOIN contacts c ON c.id = dc.contact_id WHERE dc.deal_id = ${id} AND c.deleted_at IS NULL ORDER BY dc.is_primary DESC, c.first_name`),
      row.company_id ? q1(sql`SELECT id, name FROM companies WHERE id = ${row.company_id as number} AND deleted_at IS NULL`) : undefined,
      loadLineItems('deal', id),
      q1(sql`SELECT id, name FROM users WHERE id = ${row.owner_id}`),
      row.lead_id ? q1(sql`SELECT id, title FROM leads WHERE id = ${row.lead_id as number}`) : undefined,
      row.lost_reason_id ? q1(sql`SELECT id, label FROM dictionary_items WHERE id = ${row.lost_reason_id as number}`) : undefined,
    ]);
    const methods = await loadMethods('contact', contacts.map((c) => c.id));
    const companyMethods = company ? await loadMethods('company', [company.id as number]) : {};
    return {
      ...camel(row),
      contacts: camelAll(contacts).map((c) => ({ ...c, methods: methods[(c as { id: number }).id] ?? [] })),
      company: company ? { ...camel(company), methods: companyMethods[company.id as number] ?? [] } : null,
      lineItems: items, owner: camel(owner), lead: camel(lead), lostReason: camel(lostReason),
    };
  });

  app.post('/deals', async (req, reply) => {
    const ctx = ctxOf(req);
    requireAny(ctx, 'deal', 'create');
    const body = parse(dealCreateSchema, req.body);
    const row = await tx((db) => createDeal(db, ctx, body));
    return reply.code(201).send(camel(row));
  });

  app.patch<IdParams>('/deals/:id', async (req) => {
    const ctx = ctxOf(req);
    const id = Number(req.params.id);
    const body = parse(dealUpdateSchema, req.body);
    return tx(async (db) => {
      const before = await getActive<DealRow>(db, 'deals', id, ctx, 'Deal');
      assertOnRecord(ctx, 'deal', 'edit', before);
      await assertRefs(ctx, [
        { table: 'companies', ids: [body.companyId], label: 'Company' },
        { table: 'contacts', ids: body.contactIds ?? [], label: 'Contact' },
        { table: 'dictionary_items', ids: [body.dealTypeId, body.sourceId], label: 'Option' },
      ], db);
      await assertMembers(ctx, [body.ownerId], db);
      const values = pickColumns(body, DEAL_COLS);
      if (body.amount !== undefined && body.amountMode === undefined) values.amount_mode = 'manual';
      if (body.custom !== undefined) {
        const defs = await loadDefs(ctx.workspaceId, 'deal', db);
        const custom = mergeCustom(defs, body.custom, before.custom);
        await assertRequired(defs, custom, before.stage_id);
        values.custom = custom;
      }
      // Pipeline change: requires a stage in the new pipeline.
      if (body.pipelineId && body.pipelineId !== before.pipeline_id) {
        const s = await resolvePipelineStage(db, ctx, 'deal', body.pipelineId, body.stageId);
        const from = await getStage(db, ctx, before.stage_id);
        values.pipeline_id = s.pipeline_id; values.stage_id = s.id; values.status = s.kind; values.previous_stage_id = before.stage_id;
        values.stage_changed_at = new Date(); values.stage_changed_by = ctx.userId;
        const row = await updateRow(db, 'deals', id, ctx.workspaceId, { ...values, updated_by: ctx.userId }, { version: body.version });
        await recordStageChange(db, ctx, 'deal', id, from, s, { pipeline: [before.pipeline_id, s.pipeline_id] });
        return camel(row);
      }
      const changes = diff(before, values);
      let row = await updateRow(db, 'deals', id, ctx.workspaceId, { ...values, updated_by: ctx.userId }, { version: body.version });
      await setDealContacts(db, id, body.contactIds);
      if (body.contactIds) changes.contacts = [null, body.contactIds];
      if (values.amount_mode === 'auto' && before.amount_mode !== 'auto') { await recalcDealAmount(db, ctx, id); row = (await q1(sql`SELECT * FROM deals WHERE id = ${id}`, db))!; }
      if (Object.keys(changes).length) await audit(db, ctx, 'deal', id, 'updated', changes);
      if (body.stageId && body.stageId !== before.stage_id) row = await moveDeal(db, ctx, id, { stageId: body.stageId });
      return camel(row);
    });
  });

  app.post<IdParams>('/deals/:id/move', async (req) => {
    const ctx = ctxOf(req);
    const body = parse(moveSchema, req.body);
    return camel(await tx((db) => moveDeal(db, ctx, Number(req.params.id), body)));
  });

  app.post<IdParams>('/deals/:id/close', async (req) => {
    const ctx = ctxOf(req);
    const id = Number(req.params.id);
    const body = parse(closeDealSchema, req.body);
    return camel(await tx(async (db) => {
      const deal = await getActive<DealRow>(db, 'deals', id, ctx, 'Deal');
      let stage: StageRow | undefined;
      if (body.stageId) {
        stage = await getStage(db, ctx, body.stageId);
        if (stage.kind !== body.outcome) throw badRequest('Stage does not match the outcome', { stageId: 'Invalid stage' });
      } else stage = await stageOfKind(db, deal.pipeline_id, body.outcome);
      if (!stage) throw badRequest(`This pipeline has no "${body.outcome}" stage`);
      return moveDeal(db, ctx, id, { stageId: stage.id, custom: body.custom, lostReasonId: body.lostReasonId, lostNote: body.lostNote });
    }));
  });

  app.post<IdParams>('/deals/:id/reopen', async (req) => {
    const ctx = ctxOf(req);
    const id = Number(req.params.id);
    const body = (req.body ?? {}) as { stageId?: number };
    return camel(await tx(async (db) => {
      const deal = await getActive<DealRow>(db, 'deals', id, ctx, 'Deal');
      if (deal.status === 'open') throw badRequest('Deal is already open');
      let target: number | undefined = body.stageId ? Number(body.stageId) : undefined;
      if (!target && deal.previous_stage_id) {
        const prev = await getStage(db, ctx, deal.previous_stage_id).catch(() => null);
        if (prev && prev.kind === 'open' && prev.pipeline_id === deal.pipeline_id) target = prev.id;
      }
      target ??= (await stageOfKind(db, deal.pipeline_id, 'open'))?.id;
      if (!target) throw badRequest('This pipeline has no open stages');
      return moveDeal(db, ctx, id, { stageId: target });
    }));
  });

  app.put<IdParams>('/deals/:id/line-items', async (req) => {
    const ctx = ctxOf(req);
    const id = Number(req.params.id);
    const body = parse(lineItemsSchema, req.body);
    return tx(async (db) => {
      const deal = await getActive<DealRow>(db, 'deals', id, ctx, 'Deal');
      assertOnRecord(ctx, 'deal', 'edit', deal);
      const before = await loadLineItems('deal', id, db);
      await replaceLineItems(db, ctx, 'deal', id, body.items);
      const after = await loadLineItems('deal', id, db);
      await audit(db, ctx, 'deal', id, 'updated', { lineItems: [before.length, after.length] });
      const fresh = await q1<{ amount: string; amount_mode: string }>(sql`SELECT amount, amount_mode FROM deals WHERE id = ${id}`, db);
      return { lineItems: after, amount: fresh!.amount, amountMode: fresh!.amount_mode, totals: calcTotals(body.items) };
    });
  });
}
