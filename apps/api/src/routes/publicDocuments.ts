/**
 * The customer's page for a quote or invoice (/d/<token>, link in the email): view it, download the PDF, accept or
 * decline a quote (typing their name), pay an invoice by KHQR. No sign-in; the long random token is the key.
 * The team is notified the first time the customer opens it and when they answer.
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { pool, q, q1, sql, tx, type Db } from '../db/index.ts';
import { audit } from '../lib/audit.ts';
import { systemCtx } from '../lib/context.ts';
import { AppError, notFound } from '../lib/errors.ts';
import { invoiceKhqr } from '../lib/invoiceKhqr.ts';
import { camelAll } from '../lib/records.ts';
import { parse } from '../lib/validate.ts';
import { documentSettings, loadItems, renderPdf, type Doc } from './documents.ts';

type TokenParams = { Params: { token: string } };
const acceptSchema = z.object({ name: z.string().trim().min(2, 'Type your full name').max(120), note: z.string().trim().max(1000).optional() });
const declineSchema = z.object({ reason: z.string().trim().max(1000).optional() });

async function byToken(token: string, db: Db = pool, lock = false): Promise<Doc> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw notFound('Document');
  const d = await q1<Doc & { deleted_at?: Date | null }>(sql`SELECT * FROM documents WHERE public_token_hash = ${createHash('sha256').update(token).digest('hex')}
    ${lock ? sql`FOR UPDATE` : sql``}`, db);
  // Drafts never had a link; a link to a deleted deal leads nowhere.
  if (!d || d.status === 'draft') throw notFound('Document');
  const deal = await q1(sql`SELECT 1 FROM deals WHERE id = ${d.deal_id} AND deleted_at IS NULL`, db);
  if (!deal) throw notFound('Document');
  return d;
}

const expired = (d: Doc) => d.kind === 'quote' && !!d.due_date && d.due_date < new Date().toISOString().slice(0, 10);

/** Tells the deal's owner (and whoever created the document) in the app. */
async function notifyTeam(db: Db, d: Doc, title: string, body: string) {
  await q(sql`INSERT INTO notifications (workspace_id, user_id, kind, title, body, entity_type, entity_id)
    SELECT DISTINCT ${d.workspace_id}::bigint, u, 'document', ${title}, ${body}, 'deal', ${d.deal_id}::bigint
    FROM (SELECT owner_id AS u FROM deals WHERE id = ${d.deal_id} UNION SELECT created_by FROM documents WHERE id = ${d.id}) x
    WHERE u IS NOT NULL AND EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = x.u AND m.workspace_id = ${d.workspace_id} AND m.status = 'active')`, db);
}

const label = (d: Doc) => `${d.kind === 'quote' ? 'Quote' : 'Invoice'} ${d.number}`;

export async function publicDocumentRoutes(app: FastifyInstance) {
  app.get<TokenParams>('/public/documents/:token', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const d = await byToken(req.params.token);
    // The first view is worth knowing about ("they opened it").
    if (!d.viewed_at) {
      await tx(async (db) => {
        const first = await q1(sql`UPDATE documents SET viewed_at = now() WHERE id = ${d.id} AND viewed_at IS NULL RETURNING id`, db);
        if (!first) return;
        await audit(db, systemCtx(d.workspace_id, 0), 'deal', d.deal_id, `${d.kind}_viewed`, { document: { id: d.id, number: d.number } }, 'system');
        await notifyTeam(db, d, `${d.bill_to_name || 'The customer'} opened ${label(d)}`, 'Opened from the link in your email.');
      });
    }
    const s = await documentSettings(d.workspace_id);
    const balance = (Number(d.total) - Number(d.paid_amount ?? 0)).toFixed(2);
    const k = d.kind === 'invoice' ? invoiceKhqr(d, s.khqr) : null;
    return {
      kind: d.kind, number: d.number, status: d.status, currency: d.currency, issueDate: d.issue_date, dueDate: d.due_date,
      billToName: d.bill_to_name, billToDetails: d.bill_to_details, notes: d.notes,
      listTotal: d.list_total, discount: d.discount, tax: d.tax, total: d.total, paidAmount: d.paid_amount, balance,
      items: camelAll(await loadItems(d.id)).map((i) => ({ name: i.name, quantity: i.quantity, unit: i.unit, unitPrice: i.unitPrice, discountType: i.discountType, discountValue: i.discountValue, taxRate: i.taxRate, lineTotal: i.lineTotal })),
      seller: { name: s.sellerName, details: s.companyDetails },
      expired: expired(d), canRespond: d.kind === 'quote' && d.status === 'sent' && !expired(d),
      response: d.responded_at ? { at: d.responded_at, by: d.responded_by_name, note: d.customer_note } : null,
      khqr: k?.available ? { payload: k.payload, amount: k.amount, currency: k.currency, expiresAt: k.expiresAt, merchantName: k.merchantName, accountId: k.accountId } : null,
    };
  });

  app.get<TokenParams>('/public/documents/:token/pdf', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply: FastifyReply) => {
    const d = await byToken(req.params.token);
    const pdf = await renderPdf(systemCtx(d.workspace_id, 0), d);
    return reply.header('content-type', 'application/pdf').header('content-disposition', `attachment; filename="${pdf.filename}"`)
      .header('cache-control', 'private, no-store').send(pdf.buffer);
  });

  /** The customer accepts a quote: their typed name and an optional note are kept with it. */
  app.post<TokenParams>('/public/documents/:token/accept', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const body = parse(acceptSchema, req.body);
    await tx(async (db) => {
      const d = await byToken(req.params.token, db, true);
      if (d.kind !== 'quote') throw new AppError(409, 'NOT_A_QUOTE', 'Only quotes can be accepted');
      if (d.status !== 'sent') throw new AppError(409, 'ALREADY_ANSWERED', d.status === 'accepted' ? 'This quote has already been accepted.' : 'This quote is no longer open.');
      if (expired(d)) throw new AppError(409, 'EXPIRED', 'This quote has expired. Please contact us for a new one.');
      await q(sql`UPDATE documents SET status = 'accepted', status_changed_at = now(), updated_at = now(), responded_at = now(),
        responded_by_name = ${body.name}, customer_note = ${body.note ?? null} WHERE id = ${d.id}`, db);
      await audit(db, systemCtx(d.workspace_id, 0), 'deal', d.deal_id, 'quote_accepted',
        { document: { id: d.id, number: d.number, total: d.total, currency: d.currency }, via: 'online', by: body.name, note: body.note ?? null }, 'system');
      await notifyTeam(db, d, `${body.name} accepted ${label(d)}`, body.note ? `“${body.note.slice(0, 200)}”` : 'Accepted online. You can create the invoice from the quote.');
    });
    return { ok: true };
  });

  app.post<TokenParams>('/public/documents/:token/decline', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const body = parse(declineSchema, req.body);
    await tx(async (db) => {
      const d = await byToken(req.params.token, db, true);
      if (d.kind !== 'quote') throw new AppError(409, 'NOT_A_QUOTE', 'Only quotes can be declined');
      if (d.status !== 'sent') throw new AppError(409, 'ALREADY_ANSWERED', 'This quote is no longer open.');
      await q(sql`UPDATE documents SET status = 'declined', status_changed_at = now(), updated_at = now(), responded_at = now(),
        responded_by_name = NULL, customer_note = ${body.reason ?? null} WHERE id = ${d.id}`, db);
      await audit(db, systemCtx(d.workspace_id, 0), 'deal', d.deal_id, 'quote_declined',
        { document: { id: d.id, number: d.number }, via: 'online', reason: body.reason ?? null }, 'system');
      await notifyTeam(db, d, `${label(d)} was declined`, body.reason ? `Reason: “${body.reason.slice(0, 200)}”` : 'Declined online without a reason.');
    });
    return { ok: true };
  });
}
