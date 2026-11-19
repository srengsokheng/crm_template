import { createHash, randomBytes } from 'node:crypto';
import { openSecret, sealSecret } from '../lib/secrets.ts';
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
import { calcLine, calcTotals, documentCreateSchema, documentEmailSchema, documentSettingsSchema, documentStatusSchema, documentUpdateSchema, lineItemSchema, listQuerySchema, moneyCompare, moneyMinus, paymentSchema, ctLabel } from '@crm/shared';
import { config } from '../config.ts';
import { likeTerm, qs, runList } from '../lib/list.ts';
import { documentMail, queueMail, workspaceSender } from '../lib/mailer.ts';
import { and, pool, q, q1, sql, tx, type Db } from '../db/index.ts';
import { audit } from '../lib/audit.ts';
import type { Ctx } from '../lib/context.ts';
import { renderDocumentPdf } from '../lib/documentPdf.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';
import { ctxOf } from '../lib/http.ts';
import { assertOnRecord, canOnRecord, requireAdmin, requireAny, scopeWhere } from '../lib/permissions.ts';
import { assertRefs, camel, camelAll } from '../lib/records.ts';
import { parse } from '../lib/validate.ts';
import { invoiceKhqr } from '../lib/invoiceKhqr.ts';

type Kind = 'quote' | 'invoice';
interface Doc {
  id: number; workspace_id: number; deal_id: number; kind: Kind; number: string | null; status: string; currency: string;
  issue_date: string | null; due_date: string | null; bill_to_name: string; bill_to_details: string; notes: string;
  list_total: string; discount: string; tax: string; total: string; source_quote_id: number | null; paid_amount: string;
  public_token_hash?: string | null; public_token_sealed?: string | null; viewed_at?: Date | null; responded_at?: Date | null;
  responded_by_name?: string | null; customer_note?: string | null;
  signature?: number[][] | null; signed_ip?: string | null; signed_user_agent?: string | null;
}
export type { Doc };
type Item = z.output<typeof lineItemSchema>;
export type DocumentSettings = z.output<typeof documentSettingsSchema>;

/** Allowed status changes. Drafts are deleted, not voided. */
const NEXT: Record<Kind, Record<string, string[]>> = {
  quote: { draft: ['sent'], sent: ['accepted', 'declined'], accepted: [], declined: ['sent'] },
  invoice: { draft: ['sent'], sent: ['paid', 'void'], paid: [], void: [] },
};

export async function loadDeal(db: Db, ctx: Ctx, dealId: number, action: 'view' | 'edit') {
  if (!Number.isInteger(dealId)) throw notFound('Deal');
  const deal = await q1<{ id: number; owner_id: number; visibility: string; pipeline_id: number; title: string; currency: string; company_id: number | null }>(sql`
    SELECT id, owner_id, visibility, pipeline_id, title, currency, company_id FROM deals
    WHERE id = ${dealId} AND workspace_id = ${ctx.workspaceId} AND deleted_at IS NULL`, db);
  if (!deal) throw notFound('Deal');
  assertOnRecord(ctx, 'deal', action, deal);
  return deal;
}

export async function loadDoc(db: Db, ctx: Ctx, id: number, action: 'view' | 'edit', lock = false) {
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

export const loadItems = (docId: number, db: Db = pool) => q<Record<string, unknown>>(sql`SELECT id, product_id, name, unit_price, quantity, unit, discount_type,
  discount_value, tax_rate, tax_included, line_total, sort FROM document_items WHERE document_id = ${docId} ORDER BY sort, id`, db);

/** Replaces the items and stores freshly computed totals (the server is the source of truth). */
export async function writeItems(db: Db, ctx: Ctx, docId: number, items: Item[]) {
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
export const asItems = (rows: Record<string, unknown>[]): Item[] => rows.map((r) => ({
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

/** The customer's link to a sent document (made the first time it's needed). */
export const customerUrl = (token: string) => `${config.appUrl.replace(/\/$/, '')}/d/${token}`;
export async function ensureLink(db: Db, doc: Doc): Promise<string> {
  if (doc.public_token_sealed) return customerUrl(openSecret(doc.public_token_sealed));
  const token = randomBytes(24).toString('base64url');
  await q(sql`UPDATE documents SET public_token_hash = ${createHash('sha256').update(token).digest('hex')}, public_token_sealed = ${sealSecret(token)}
    WHERE id = ${doc.id} AND public_token_sealed IS NULL`, db);
  const again = await q1<{ public_token_sealed: string }>(sql`SELECT public_token_sealed FROM documents WHERE id = ${doc.id}`, db);
  return customerUrl(openSecret(again!.public_token_sealed));
}

async function present(doc: Doc, db: Db = pool) {
  const payments = doc.kind === 'invoice'
    ? camelAll(await q(sql`SELECT p.id, p.amount, p.paid_on, p.method, p.note, p.created_at, u.name AS created_by_name
        FROM document_payments p LEFT JOIN users u ON u.id = p.created_by WHERE p.document_id = ${doc.id} ORDER BY p.paid_on, p.id`, db))
    : [];
  const balance = moneyMinus(doc.total, doc.paid_amount ?? 0);
  const { public_token_hash: _h, public_token_sealed: sealed, ...rest } = doc;
  const customerLink = doc.status !== 'draft' && sealed ? customerUrl(openSecret(sealed)) : null;
  return { ...camel(rest as unknown as Record<string, unknown>), items: camelAll(await loadItems(doc.id, db)), payments, balance, customerUrl: customerLink };
}

/** Recompute paid_amount from the payments; an invoice is paid exactly when the payments cover the total. */
async function syncPayments(db: Db, docId: number): Promise<Doc> {
  return (await q1<Doc>(sql`UPDATE documents d SET paid_amount = coalesce((SELECT sum(amount) FROM document_payments WHERE document_id = d.id), 0),
      status = CASE WHEN d.status IN ('sent','paid') THEN
        CASE WHEN coalesce((SELECT sum(amount) FROM document_payments WHERE document_id = d.id), 0) >= d.total THEN 'paid' ELSE 'sent' END
        ELSE d.status END,
      status_changed_at = CASE WHEN d.status IN ('sent','paid') AND d.status <> (CASE WHEN coalesce((SELECT sum(amount) FROM document_payments WHERE document_id = d.id), 0) >= d.total THEN 'paid' ELSE 'sent' END)
        THEN now() ELSE d.status_changed_at END,
      updated_at = now()
    WHERE d.id = ${docId} RETURNING *`, db))!;
}

/** Status change (also used when a draft is emailed: it is sent first). Numbers are taken when first sent. */
export async function changeStatus(db: Db, ctx: Ctx, doc: Doc, status: string): Promise<Doc> {
  if (!NEXT[doc.kind][doc.status]?.includes(status)) throw conflict(`A ${doc.status} ${doc.kind} can’t be marked as ${status}`);
  if (status === 'void' && Number(doc.paid_amount) > 0) throw conflict('This invoice has payments; delete them before voiding it');
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
  if (status === 'sent') await ensureLink(db, doc); // the customer's link (view, accept, pay)
  if (status === 'paid') {
    // "Mark as paid" records the remaining balance as one payment, so the payment history stays complete.
    const balance = moneyMinus(doc.total, doc.paid_amount);
    if (moneyCompare(balance, 0) > 0) {
      await q(sql`INSERT INTO document_payments (workspace_id, document_id, amount, paid_on, method, created_by)
        VALUES (${ctx.workspaceId}, ${doc.id}, ${balance}, current_date, 'Marked as paid', ${ctx.userId})`, db);
    }
    await q(sql`UPDATE documents SET paid_amount = total WHERE id = ${doc.id}`, db);
  }
  await q(sql`UPDATE documents SET status = ${status}, status_changed_at = now(), updated_at = now() WHERE id = ${doc.id}`, db);
  const after = (await q1<Doc>(sql`SELECT * FROM documents WHERE id = ${doc.id}`, db))!;
  await audit(db, ctx, 'deal', doc.deal_id, `${doc.kind}_${status}`, { document: { id: doc.id, number: after.number, total: after.total, currency: after.currency } });
  return after;
}

export async function renderPdf(ctx: Ctx, doc: Doc, db: Db = pool): Promise<{ buffer: Buffer; filename: string }> {
  const s = await documentSettings(ctx.workspaceId, db);
  const items = await loadItems(doc.id, db);
  const buffer = renderDocumentPdf({
    kind: doc.kind, number: doc.number, status: doc.status, currency: doc.currency, issueDate: doc.issue_date, dueDate: doc.due_date,
    billToName: doc.bill_to_name, billToDetails: doc.bill_to_details, notes: doc.notes,
    listTotal: doc.list_total, discount: doc.discount, tax: doc.tax, total: doc.total,
    paidAmount: doc.kind === 'invoice' ? doc.paid_amount : undefined,
    khqr: (() => { const k = invoiceKhqr(doc, s.khqr); return k.available ? { payload: k.payload, expiresAt: k.expiresAt } : undefined; })(),
    items: camelAll(items) as never, seller: { name: s.sellerName, details: s.companyDetails, footer: s.footer }, lang: s.customerLanguage,
    acceptance: doc.kind === 'quote' && doc.status === 'accepted' && doc.responded_by_name && doc.responded_at
      ? { name: doc.responded_by_name, at: new Date(doc.responded_at).toISOString(), signature: doc.signature ?? null } : undefined,
  });
  return { buffer, filename: `${doc.number ?? `Draft ${doc.kind}`}.pdf`.replace(/[^\w .-]/g, '_') };
}

/** Emails of the deal's company and contacts — offered as recipients. */
async function suggestedRecipients(db: Db, dealId: number): Promise<string[]> {
  const rows = await q<{ value: string }>(sql`SELECT DISTINCT m.value FROM contact_methods m WHERE m.kind = 'email' AND (
      (m.party_type = 'contact' AND m.party_id IN (SELECT contact_id FROM deal_contacts WHERE deal_id = ${dealId}))
      OR (m.party_type = 'company' AND m.party_id = (SELECT company_id FROM deals WHERE id = ${dealId})))
    ORDER BY m.value LIMIT 10`, db);
  return rows.map((r) => r.value);
}

export async function documentRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>('/deals/:id/documents', async (req) => {
    const ctx = ctxOf(req);
    const deal = await loadDeal(pool, ctx, Number(req.params.id), 'view');
    const rows = await q(sql`SELECT id, kind, number, status, currency, total, paid_amount, issue_date, due_date, source_quote_id, created_at,
      (kind = 'invoice' AND status = 'sent' AND due_date < current_date) AS overdue
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
    const { doc: loaded, deal } = await loadDoc(pool, ctx, Number(req.params.id), 'view');
    const canEdit = canOnRecord(ctx, 'deal', 'edit', deal);
    // Sent before customer links existed: give it one now (only people who may edit the deal).
    let doc = loaded;
    if (doc.status !== 'draft' && !doc.public_token_sealed && canEdit) { await ensureLink(pool, doc); doc = (await q1<Doc>(sql`SELECT * FROM documents WHERE id = ${doc.id}`))!; }
    return { ...(await present(doc)), dealTitle: deal.title, canEdit, suggestedRecipients: canEdit ? await suggestedRecipients(pool, deal.id) : [] };
  });

  // ── All quotes and invoices the user can see (through their deals) ──
  app.get('/documents', async (req) => {
    const ctx = ctxOf(req);
    requireAny(ctx, 'deal', 'view');
    const query = parse(listQuerySchema, req.query);
    const kind = qs.str(query.kind);
    const status = qs.str(query.status);
    const visible = [sql`d.workspace_id = ${ctx.workspaceId}`, sql`dl.deleted_at IS NULL`, scopeWhere(ctx, 'deal', 'view', 'dl')];
    const r = await runList({
      select: sql`d.id, d.kind, d.number, d.status, d.currency, d.total, d.paid_amount, (d.total - d.paid_amount)::text AS balance,
        d.issue_date, d.due_date, d.bill_to_name, d.deal_id, dl.title AS deal_title, d.created_at, d.last_emailed_at,
        (d.kind = 'invoice' AND d.status = 'sent' AND d.due_date < current_date) AS overdue`,
      from: sql`documents d JOIN deals dl ON dl.id = d.deal_id`,
      where: [...visible,
        kind === 'quote' || kind === 'invoice' ? sql`d.kind = ${kind}` : null,
        status === 'overdue' ? sql`d.kind = 'invoice' AND d.status = 'sent' AND d.due_date < current_date`
          : status === 'unpaid' ? sql`d.kind = 'invoice' AND d.status = 'sent'`
            : status && ['draft', 'sent', 'accepted', 'declined', 'paid', 'void'].includes(status) ? sql`d.status = ${status}` : null,
      ],
      search: (t) => sql`(d.number ILIKE ${likeTerm(t)} OR d.bill_to_name ILIKE ${likeTerm(t)} OR dl.title ILIKE ${likeTerm(t)})`,
      sorts: { number: 'd.number', issueDate: 'd.issue_date', dueDate: 'd.due_date', total: 'd.total', balance: '(d.total - d.paid_amount)', createdAt: 'd.created_at', billTo: 'lower(d.bill_to_name)' },
      defaultSort: '-createdAt',
    }, query);
    // Money owed across all unpaid invoices (not just this page or filter), in the base currency.
    const owed = await q1<{ outstanding: string; overdue: string; overdue_count: number; missing: string[] }>(sql`SELECT
        coalesce(sum(crm_to_base(d.total - d.paid_amount, d.currency, ${ctx.baseCurrency}, ${ctx.workspaceId}, current_date)), 0)::text AS outstanding,
        coalesce(sum(crm_to_base(d.total - d.paid_amount, d.currency, ${ctx.baseCurrency}, ${ctx.workspaceId}, current_date)) FILTER (WHERE d.due_date < current_date), 0)::text AS overdue,
        count(*) FILTER (WHERE d.due_date < current_date)::int AS overdue_count,
        coalesce(array_agg(DISTINCT d.currency) FILTER (WHERE crm_to_base(1, d.currency, ${ctx.baseCurrency}, ${ctx.workspaceId}, current_date) IS NULL), '{}') AS missing
      FROM documents d JOIN deals dl ON dl.id = d.deal_id WHERE ${and(visible)} AND d.kind = 'invoice' AND d.status = 'sent'`);
    return { ...r, data: camelAll(r.data as Record<string, unknown>[]), baseCurrency: ctx.baseCurrency,
      totals: { outstanding: owed?.outstanding ?? '0', overdue: owed?.overdue ?? '0', overdueCount: owed?.overdue_count ?? 0, missingRates: owed?.missing ?? [] } };
  });

  /** The KHQR payment QR for the invoice's balance due (or why there is none). A fresh one each time. */
  app.get<{ Params: { id: string } }>('/documents/:id/khqr', async (req) => {
    const ctx = ctxOf(req);
    const { doc } = await loadDoc(pool, ctx, Number(req.params.id), 'view');
    return invoiceKhqr(doc, (await documentSettings(ctx.workspaceId)).khqr);
  });

  // ── Payments ──
  app.post<{ Params: { id: string } }>('/documents/:id/payments', async (req, reply) => {
    const ctx = ctxOf(req);
    const body = parse(paymentSchema, req.body);
    const doc = await tx(async (db) => {
      const { doc } = await loadDoc(db, ctx, Number(req.params.id), 'edit', true);
      if (doc.kind !== 'invoice') throw badRequest('Payments are recorded on invoices');
      if (doc.status !== 'sent') throw conflict(doc.status === 'paid' ? 'This invoice is already paid in full' : `A ${doc.status} invoice can’t receive payments`);
      const balance = moneyMinus(doc.total, doc.paid_amount);
      if (moneyCompare(body.amount, balance) > 0) throw badRequest(`More than the remaining balance (${balance} ${doc.currency})`, { amount: 'Too much' });
      await q(sql`INSERT INTO document_payments (workspace_id, document_id, amount, paid_on, method, note, created_by)
        VALUES (${ctx.workspaceId}, ${doc.id}, ${body.amount}, ${body.paidOn}, ${body.method}, ${body.note}, ${ctx.userId})`, db);
      const after = await syncPayments(db, doc.id);
      await audit(db, ctx, 'deal', doc.deal_id, 'invoice_payment', { document: { id: doc.id, number: doc.number, currency: doc.currency }, amount: body.amount, paidInFull: after.status === 'paid' });
      return after;
    });
    return reply.code(201).send(await present(doc));
  });
  app.delete<{ Params: { id: string; pid: string } }>('/documents/:id/payments/:pid', async (req) => {
    const ctx = ctxOf(req);
    const doc = await tx(async (db) => {
      const { doc } = await loadDoc(db, ctx, Number(req.params.id), 'edit', true);
      const p = await q1<{ amount: string }>(sql`DELETE FROM document_payments WHERE id = ${Number(req.params.pid)} AND document_id = ${doc.id} RETURNING amount`, db);
      if (!p) throw notFound('Payment');
      const after = await syncPayments(db, doc.id);
      await audit(db, ctx, 'deal', doc.deal_id, 'invoice_payment_removed', { document: { id: doc.id, number: doc.number, currency: doc.currency }, amount: p.amount });
      return after;
    });
    return present(doc);
  });

  // ── Email a quote/invoice with the PDF attached (a draft is sent first, which gives it its number) ──
  app.post<{ Params: { id: string } }>('/documents/:id/email', { config: { rateLimit: { max: config.isTest ? 1000 : 20, timeWindow: '1 minute' } } }, async (req) => {
    const ctx = ctxOf(req);
    const body = parse(documentEmailSchema, req.body);
    const doc = await tx(async (db) => {
      let { doc } = await loadDoc(db, ctx, Number(req.params.id), 'edit', true);
      if (doc.status === 'void') throw conflict('A void invoice can’t be emailed');
      if (doc.status === 'draft') doc = await changeStatus(db, ctx, doc, 'sent');
      const pdf = await renderPdf(ctx, doc, db);
      const link = await ensureLink(db, doc);
      const ws = await q1<{ name: string }>(sql`SELECT name FROM workspaces WHERE id = ${ctx.workspaceId}`, db);
      await queueMail({
        ...documentMail({ to: body.to, replyTo: ctx.email, subject: body.subject, message: body.message, sender: ctx.userName, workspace: ws!.name,
          pdf: { filename: pdf.filename, base64: pdf.buffer.toString('base64') },
          button: { label: ctLabel((await documentSettings(ctx.workspaceId, db)).customerLanguage, doc.kind === 'quote' ? 'viewAccept' : 'viewPay'), url: link } }),
        fromName: await workspaceSender(ctx.workspaceId, db),
      }, db, { workspaceId: ctx.workspaceId });
      // Invoices remember who they went to: payment reminders go to the same people.
      const after = (await q1<Doc>(sql`UPDATE documents SET last_emailed_at = now(), email_to = CASE WHEN kind = 'invoice' THEN ${body.to}::text[] ELSE email_to END
        WHERE id = ${doc.id} RETURNING *`, db))!;
      await audit(db, ctx, 'deal', doc.deal_id, `${doc.kind}_emailed`, { document: { id: doc.id, number: after.number }, to: body.to });
      return after;
    });
    return present(doc);
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
      return changeStatus(db, ctx, doc, status);
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
    const { buffer: pdf, filename: name } = await renderPdf(ctx, doc);
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
