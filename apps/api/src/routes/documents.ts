/**
 * Quotes and invoices. A document belongs to a deal and follows the deal's permissions (view to see, edit to change).
 *   GET    /deals/:id/documents                list
 *   POST   /deals/:id/documents                { kind, fromQuoteId? } new draft (items from the deal, or from an accepted quote)
 *   GET    /documents/:id                      with items
 *   PATCH  /documents/:id                      drafts only: bill-to, notes, due date, items
 *   POST   /documents/:id/status               { status } sent | accepted | declined (quotes) | paid | void (invoices)
 *   DELETE /documents/:id                      drafts only
 *   GET    /documents/:id/pdf[?inline=1]
 *   GET/PUT /settings/documents                admins: company details, footer, prefixes, terms
 */
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import { calcLine, calcTotals, documentCreateSchema, documentSettingsSchema, documentStatusSchema, documentUpdateSchema, lineItemSchema } from '@crm/shared';
import { pool, q, q1, sql, tx, type Db } from '../db/index.ts';
import { audit } from '../lib/audit.ts';
import type { Ctx } from '../lib/context.ts';
import { renderDocumentPdf } from '../lib/documentPdf.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';
import { ctxOf } from '../lib/http.ts';
import { assertOnRecord, canOnRecord, requireAdmin } from '../lib/permissions.ts';
import { assertRefs, camel, camelAll } from '../lib/records.ts';
import { parse } from '../lib/validate.ts';

type Kind = 'quote' | 'invoice';
interface Doc {
  id: number; workspace_id: number; deal_id: number; kind: Kind; number: string | null; status: string; currency: string;
  issue_date: string | null; due_date: string | null; bill_to_name: string; bill_to_details: string; notes: string;
  list_total: string; discount: string; tax: string; total: string; source_quote_id: number | null;
}
type Item = z.output<typeof lineItemSchema>;
export type DocumentSettings = z.output<typeof documentSettingsSchema>;

/** Allowed status changes. Drafts are deleted, not voided. */
const NEXT: Record<Kind, Record<string, string[]>> = {
  quote: { draft: ['sent'], sent: ['accepted', 'declined'], accepted: [], declined: ['sent'] },
  invoice: { draft: ['sent'], sent: ['paid', 'void'], paid: [], void: [] },
};

async function loadDeal(db: Db, ctx: Ctx, dealId: number, action: 'view' | 'edit') {
  if (!Number.isInteger(dealId)) throw notFound('Deal');
  const deal = await q1<{ id: number; owner_id: number; visibility: string; pipeline_id: number; title: string; currency: string; company_id: number | null }>(sql`
    SELECT id, owner_id, visibility, pipeline_id, title, currency, company_id FROM deals
    WHERE id = ${dealId} AND workspace_id = ${ctx.workspaceId} AND deleted_at IS NULL`, db);
  if (!deal) throw notFound('Deal');
  assertOnRecord(ctx, 'deal', action, deal);
  return deal;
}

async function loadDoc(db: Db, ctx: Ctx, id: number, action: 'view' | 'edit', lock = false) {
  if (!Number.isInteger(id)) throw notFound('Document');
  const doc = await q1<Doc>(sql`SELECT * FROM documents WHERE id = ${id} AND workspace_id = ${ctx.workspaceId} ${lock ? sql`FOR UPDATE` : sql``}`, db);
  if (!doc) throw notFound('Document');
  const deal = await loadDeal(db, ctx, doc.deal_id, action);
  return { doc, deal };
}

export async function documentSettings(workspaceId: number, db: Db = pool): Promise<DocumentSettings & { sellerName: string }> {
  const ws = await q1<{ name: string; settings: { documents?: unknown } }>(sql`SELECT name, settings FROM workspaces WHERE id = ${workspaceId}`, db);
  const parsed = documentSettingsSchema.safeParse(ws?.settings.documents ?? {});
  return { ...(parsed.success ? parsed.data : documentSettingsSchema.parse({})), sellerName: ws?.name ?? '' };
}

const loadItems = (docId: number, db: Db = pool) => q<Record<string, unknown>>(sql`SELECT id, product_id, name, unit_price, quantity, unit, discount_type,
  discount_value, tax_rate, tax_included, line_total, sort FROM document_items WHERE document_id = ${docId} ORDER BY sort, id`, db);

/** Replaces the items and stores freshly computed totals (the server is the source of truth). */
async function writeItems(db: Db, ctx: Ctx, docId: number, items: Item[]) {
  await assertRefs(ctx, [{ table: 'products', ids: items.map((i) => i.productId), label: 'Product' }], db);
  await q(sql`DELETE FROM document_items WHERE document_id = ${docId}`, db);
  let sort = 0;
  for (const i of items) {
    const r = calcLine(i);
    await q(sql`INSERT INTO document_items (document_id, product_id, name, unit_price, quantity, unit, discount_type, discount_value, tax_rate, tax_included, line_total, sort)
      VALUES (${docId}, ${i.productId ?? null}, ${i.name}, ${i.unitPrice}, ${i.quantity}, ${i.unit}, ${i.discountType ?? null}, ${i.discountValue ?? 0},
              ${i.taxRate ?? null}, ${i.taxIncluded ?? false}, ${r.lineTotal}, ${sort++})`, db);
  }
  const t = calcTotals(items);
  await q(sql`UPDATE documents SET list_total = ${t.listTotal}, discount = ${t.discount}, tax = ${t.tax}, total = ${t.total}, updated_at = now() WHERE id = ${docId}`, db);
}

/** Items stored in the database → the shape the schema/calculations use. */
const asItems = (rows: Record<string, unknown>[]): Item[] => rows.map((r) => ({
  productId: (r.product_id as number | null) ?? null, name: String(r.name), unitPrice: String(r.unit_price), quantity: Number(r.quantity), unit: String(r.unit),
  discountType: (r.discount_type as 'percent' | 'amount' | null) ?? null, discountValue: r.discount_type ? Number(r.discount_value) : null,
  taxRate: r.tax_rate === null ? null : Number(r.tax_rate), taxIncluded: Boolean(r.tax_included),
}));

async function billTo(db: Db, dealId: number, companyId: number | null) {
  const company = companyId ? await q1<{ name: string; address: Record<string, string | null> | null; email: string | null }>(sql`
    SELECT c.name, c.address, (SELECT value FROM contact_methods m WHERE m.party_type = 'company' AND m.party_id = c.id AND m.kind = 'email' ORDER BY is_primary DESC, sort LIMIT 1) AS email
    FROM companies c WHERE c.id = ${companyId} AND c.deleted_at IS NULL`, db) : null;
  const contact = await q1<{ name: string; email: string | null }>(sql`
    SELECT trim(concat_ws(' ', p.first_name, p.last_name)) AS name,
      (SELECT value FROM contact_methods m WHERE m.party_type = 'contact' AND m.party_id = p.id AND m.kind = 'email' ORDER BY is_primary DESC, sort LIMIT 1) AS email
    FROM deal_contacts dc JOIN contacts p ON p.id = dc.contact_id AND p.deleted_at IS NULL WHERE dc.deal_id = ${dealId} ORDER BY dc.contact_id LIMIT 1`, db);
  const a = company?.address ?? {};
  const address = [a.street, [a.postalCode, a.city].filter(Boolean).join(' '), a.region, a.country].filter(Boolean) as string[];
  if (company) return { name: company.name, details: [contact?.name ? `Attn: ${contact.name}` : null, ...address, company.email ?? contact?.email].filter(Boolean).join('\n') };
  if (contact) return { name: contact.name, details: contact.email ?? '' };
  return { name: '', details: '' };
}

async function present(doc: Doc, db: Db = pool) {
  return { ...camel(doc as unknown as Record<string, unknown>), items: camelAll(await loadItems(doc.id, db)) };
}

export async function documentRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>('/deals/:id/documents', async (req) => {
    const ctx = ctxOf(req);
    const deal = await loadDeal(pool, ctx, Number(req.params.id), 'view');
    const rows = await q(sql`SELECT id, kind, number, status, currency, total, issue_date, due_date, source_quote_id, created_at
      FROM documents WHERE workspace_id = ${ctx.workspaceId} AND deal_id = ${deal.id} ORDER BY created_at DESC, id DESC`);
    return { data: camelAll(rows) };
  });

  app.post<{ Params: { id: string } }>('/deals/:id/documents', async (req, reply) => {
    const ctx = ctxOf(req);
    const body = parse(documentCreateSchema, req.body);
    const doc = await tx(async (db) => {
      const deal = await loadDeal(db, ctx, Number(req.params.id), 'edit');
      let items: Item[];
      let bill = await billTo(db, deal.id, deal.company_id);
      let notes = '';
      let currency = deal.currency;
      if (body.fromQuoteId) {
        const quote = await q1<Doc>(sql`SELECT * FROM documents WHERE id = ${body.fromQuoteId} AND workspace_id = ${ctx.workspaceId} AND deal_id = ${deal.id} AND kind = 'quote'`, db);
        if (!quote) throw notFound('Quote');
        if (body.kind !== 'invoice') throw badRequest('A quote can only be turned into an invoice');
        if (quote.status !== 'accepted') throw conflict('Only an accepted quote can be turned into an invoice');
        items = asItems(await loadItems(quote.id, db));
        bill = { name: quote.bill_to_name, details: quote.bill_to_details };
        notes = quote.notes;
        currency = quote.currency;
      } else {
        items = asItems(await q(sql`SELECT * FROM line_items WHERE parent_type = 'deal' AND parent_id = ${deal.id} ORDER BY sort, id`, db));
      }
      const ins = await q1<Doc>(sql`INSERT INTO documents (workspace_id, deal_id, kind, currency, bill_to_name, bill_to_details, notes, source_quote_id, created_by)
        VALUES (${ctx.workspaceId}, ${deal.id}, ${body.kind}, ${currency}, ${bill.name}, ${bill.details}, ${notes}, ${body.fromQuoteId ?? null}, ${ctx.userId}) RETURNING *`, db);
      await writeItems(db, ctx, ins!.id, items);
      await audit(db, ctx, 'deal', deal.id, 'document_created', { document: { id: ins!.id, kind: body.kind } });
      return (await q1<Doc>(sql`SELECT * FROM documents WHERE id = ${ins!.id}`, db))!;
    });
    return reply.code(201).send(await present(doc));
  });

  app.get<{ Params: { id: string } }>('/documents/:id', async (req) => {
    const ctx = ctxOf(req);
    const { doc, deal } = await loadDoc(pool, ctx, Number(req.params.id), 'view');
    return { ...(await present(doc)), dealTitle: deal.title, canEdit: canOnRecord(ctx, 'deal', 'edit', deal) };
  });

  app.patch<{ Params: { id: string } }>('/documents/:id', async (req) => {
    const ctx = ctxOf(req);
    const body = parse(documentUpdateSchema, req.body);
    const doc = await tx(async (db) => {
      const { doc } = await loadDoc(db, ctx, Number(req.params.id), 'edit', true);
      if (doc.status !== 'draft') throw conflict(`This ${doc.kind} has been sent and can no longer be changed`);
      await q(sql`UPDATE documents SET
          bill_to_name = coalesce(${body.billToName ?? null}, bill_to_name),
          bill_to_details = coalesce(${body.billToDetails ?? null}, bill_to_details),
          notes = coalesce(${body.notes ?? null}, notes),
          due_date = CASE WHEN ${body.dueDate !== undefined} THEN ${body.dueDate ?? null}::date ELSE due_date END,
          updated_at = now()
        WHERE id = ${doc.id}`, db);
      if (body.items) await writeItems(db, ctx, doc.id, body.items);
      return (await q1<Doc>(sql`SELECT * FROM documents WHERE id = ${doc.id}`, db))!;
    });
    return present(doc);
  });

  app.post<{ Params: { id: string } }>('/documents/:id/status', async (req) => {
    const ctx = ctxOf(req);
    const { status } = parse(documentStatusSchema, req.body);
    const doc = await tx(async (db) => {
      const { doc } = await loadDoc(db, ctx, Number(req.params.id), 'edit', true);
      if (!NEXT[doc.kind][doc.status]?.includes(status)) throw conflict(`A ${doc.status} ${doc.kind} can’t be marked as ${status}`);
      if (status === 'sent' && !doc.number) {
        const count = await q1<{ n: number }>(sql`SELECT count(*)::int AS n FROM document_items WHERE document_id = ${doc.id}`, db);
        if (!count?.n) throw badRequest(`Add at least one item before sending the ${doc.kind}`);
        const s = await documentSettings(ctx.workspaceId, db);
        const counter = await q1<{ last_no: number }>(sql`INSERT INTO document_counters (workspace_id, kind, last_no) VALUES (${ctx.workspaceId}, ${doc.kind}, 1)
          ON CONFLICT (workspace_id, kind) DO UPDATE SET last_no = document_counters.last_no + 1 RETURNING last_no`, db);
        const number = `${doc.kind === 'quote' ? s.quotePrefix : s.invoicePrefix}${String(counter!.last_no).padStart(4, '0')}`;
        const days = doc.kind === 'quote' ? s.quoteValidDays : s.paymentTermsDays;
        await q(sql`UPDATE documents SET number = ${number}, issue_date = coalesce(issue_date, current_date),
          due_date = coalesce(due_date, coalesce(issue_date, current_date) + ${days}::int) WHERE id = ${doc.id}`, db);
      }
      await q(sql`UPDATE documents SET status = ${status}, status_changed_at = now(), updated_at = now() WHERE id = ${doc.id}`, db);
      const after = (await q1<Doc>(sql`SELECT * FROM documents WHERE id = ${doc.id}`, db))!;
      await audit(db, ctx, 'deal', doc.deal_id, `${doc.kind}_${status}`, { document: { id: doc.id, number: after.number, total: after.total, currency: after.currency } });
      return after;
    });
    return present(doc);
  });

  app.delete<{ Params: { id: string } }>('/documents/:id', async (req, reply) => {
    const ctx = ctxOf(req);
    await tx(async (db) => {
      const { doc } = await loadDoc(db, ctx, Number(req.params.id), 'edit', true);
      if (doc.status !== 'draft') throw conflict(`Only drafts can be deleted${doc.kind === 'invoice' ? '; void the invoice instead' : ''}`);
      await q(sql`DELETE FROM documents WHERE id = ${doc.id}`, db);
      await audit(db, ctx, 'deal', doc.deal_id, 'document_deleted', { document: { id: doc.id, kind: doc.kind } });
    });
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string }; Querystring: { inline?: string } }>('/documents/:id/pdf', async (req, reply) => {
    const ctx = ctxOf(req);
    const { doc } = await loadDoc(pool, ctx, Number(req.params.id), 'view');
    const s = await documentSettings(ctx.workspaceId);
    const items = await loadItems(doc.id);
    const pdf = renderDocumentPdf({
      kind: doc.kind, number: doc.number, status: doc.status, currency: doc.currency, issueDate: doc.issue_date, dueDate: doc.due_date,
      billToName: doc.bill_to_name, billToDetails: doc.bill_to_details, notes: doc.notes,
      listTotal: doc.list_total, discount: doc.discount, tax: doc.tax, total: doc.total,
      items: camelAll(items) as never, seller: { name: s.sellerName, details: s.companyDetails, footer: s.footer },
    });
    const name = `${doc.number ?? `Draft ${doc.kind}`}.pdf`.replace(/[^\w .-]/g, '_');
    return reply.header('content-type', 'application/pdf')
      .header('content-disposition', `${req.query.inline === '1' ? 'inline' : 'attachment'}; filename="${name}"`)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, max-age=0, no-store')
      .send(pdf);
  });

  app.get('/settings/documents', async (req) => {
    const ctx = ctxOf(req);
    requireAdmin(ctx);
    const { sellerName: _seller, ...s } = await documentSettings(ctx.workspaceId);
    return s;
  });
  app.put('/settings/documents', async (req) => {
    const ctx = ctxOf(req);
    requireAdmin(ctx);
    const body = parse(documentSettingsSchema, req.body);
    await q(sql`UPDATE workspaces SET settings = settings || jsonb_build_object('documents', ${JSON.stringify(body)}::jsonb) WHERE id = ${ctx.workspaceId}`);
    return body;
  });
}
