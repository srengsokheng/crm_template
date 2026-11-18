/**
 * Recurring invoices: a schedule made from an invoice (every 1, 2, 3, 6 or 12 months, from a start date, forever or
 * N times). On each date the worker creates a new invoice with the same items and bill-to, as a draft to check or
 * sent by email (PDF attached, customer link). Dates follow the start date's day; short months use their last day.
 *
 * Permissions: like invoices — people who may edit the deal set up and change schedules; who may see the deal sees them.
 */
import type { FastifyInstance } from 'fastify';
import { recurringCreateSchema, recurringUpdateSchema } from '@crm/shared';
import { pool, q, q1, sql, tx, type Db } from '../db/index.ts';
import { audit } from '../lib/audit.ts';
import { systemCtx, type Ctx } from '../lib/context.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';
import { ctxOf } from '../lib/http.ts';
import { documentMail, queueMail, workspaceSender } from '../lib/mailer.ts';
import { canOnRecord, scopeWhere } from '../lib/permissions.ts';
import { camel, camelAll } from '../lib/records.ts';
import { parse } from '../lib/validate.ts';
import { asItems, changeStatus, ensureLink, loadDeal, renderPdf, writeItems, type Doc } from './documents.ts';

interface Schedule {
  id: number; workspace_id: number; deal_id: number; source_id: number | null; every_months: number; start_on: string; next_run: string;
  ends_after: number | null; runs: number; period: number; mode: 'draft' | 'send'; email_to: string[]; message: string; currency: string;
  bill_to_name: string; bill_to_details: string; notes: string; items: ReturnType<typeof asItems>; status: string;
  last_error: string | null; last_document_id: number | null; created_by: number | null;
}

const FIELDS = sql`r.id, r.deal_id, r.source_id, r.every_months, r.start_on, r.next_run, r.ends_after, r.runs, r.mode, r.email_to, r.status,
  r.last_error, r.last_document_id, r.currency, r.created_at, u.name AS created_by_name, d.title AS deal_title,
  (SELECT total::text FROM documents WHERE id = coalesce(r.last_document_id, r.source_id)) AS amount,
  (SELECT number FROM documents WHERE id = r.last_document_id) AS last_number, d.owner_id, d.visibility`;

/** Runs one schedule once: makes (and maybe sends) the invoice, moves the next date. Returns the new invoice. */
async function runOnce(db: Db, s: Schedule): Promise<Doc> {
  const creator = s.created_by ? await q1<{ name: string; email: string }>(sql`SELECT u.name, u.email FROM users u
    JOIN memberships m ON m.user_id = u.id AND m.workspace_id = ${s.workspace_id} AND m.status = 'active' WHERE u.id = ${s.created_by}`, db) : null;
  if (!creator) throw new Error('The person who set up this schedule is no longer in the workspace. Set it up again from the invoice.');
  const ctx: Ctx = { ...systemCtx(s.workspace_id, s.created_by!), userName: creator.name, email: creator.email };
  const deal = await q1<{ id: number }>(sql`SELECT id FROM deals WHERE id = ${s.deal_id} AND deleted_at IS NULL`, db);
  if (!deal) throw new Error('The deal was deleted.');
  const ins = (await q1<Doc>(sql`INSERT INTO documents (workspace_id, deal_id, kind, currency, bill_to_name, bill_to_details, notes, created_by)
    VALUES (${s.workspace_id}, ${s.deal_id}, 'invoice', ${s.currency}, ${s.bill_to_name}, ${s.bill_to_details}, ${s.notes}, ${s.created_by}) RETURNING *`, db))!;
  await writeItems(db, ctx, ins.id, s.items);
  let doc = (await q1<Doc>(sql`SELECT * FROM documents WHERE id = ${ins.id}`, db))!;
  if (s.mode === 'send') {
    doc = await changeStatus(db, ctx, doc, 'sent');
    const pdf = await renderPdf(ctx, doc, db);
    const link = await ensureLink(db, doc);
    const ws = await q1<{ name: string }>(sql`SELECT name FROM workspaces WHERE id = ${s.workspace_id}`, db);
    await queueMail({
      ...documentMail({
        to: s.email_to, replyTo: creator.email, subject: `Invoice ${doc.number} from ${ws!.name}`,
        message: s.message || `Hello${s.bill_to_name ? ` ${s.bill_to_name}` : ''},\n\nPlease find invoice ${doc.number} attached.${doc.due_date ? ` Payment is due by ${doc.due_date}.` : ''}\n\nKind regards,\n${creator.name}`,
        sender: creator.name, workspace: ws!.name, pdf: { filename: pdf.filename, base64: pdf.buffer.toString('base64') },
        button: { label: 'View and pay online', url: link },
      }),
      fromName: await workspaceSender(s.workspace_id, db),
    }, db, { workspaceId: s.workspace_id });
    doc = (await q1<Doc>(sql`UPDATE documents SET last_emailed_at = now() WHERE id = ${doc.id} RETURNING *`, db))!;
  }
  const runs = s.runs + 1;
  const ended = s.ends_after !== null && runs >= s.ends_after;
  await q(sql`UPDATE recurring_invoices SET runs = ${runs}, period = period + 1, last_document_id = ${doc.id}, last_error = NULL,
      next_run = (start_on + make_interval(months => every_months * (period + 1)))::date, status = ${ended ? 'ended' : 'active'}
    WHERE id = ${s.id}`, db);
  await audit(db, ctx, 'deal', s.deal_id, 'invoice_recurring', { document: { id: doc.id, number: doc.number }, schedule: s.id, sent: s.mode === 'send' }, 'automation');
  await q(sql`INSERT INTO notifications (workspace_id, user_id, kind, title, body, entity_type, entity_id)
    VALUES (${s.workspace_id}, ${s.created_by}, 'document',
      ${s.mode === 'send' ? `Invoice ${doc.number} was sent (recurring)` : 'A recurring invoice draft is ready to check'},
      ${`${s.bill_to_name || 'Invoice'}${ended ? ' — that was the last one of the schedule' : ''}`}, 'deal', ${s.deal_id})`, db);
  return doc;
}

/** Worker: runs every due schedule (catching up missed months, at most 12 per schedule per round). */
export async function runRecurringInvoices(today?: string): Promise<number> {
  let made = 0;
  for (let guard = 0; guard < 12; guard++) {
    const due = await q<{ id: number }>(sql`SELECT id FROM recurring_invoices WHERE status = 'active' AND next_run <= coalesce(${today ?? null}::date, current_date) ORDER BY next_run, id LIMIT 50`);
    if (!due.length) break;
    for (const { id } of due) {
      try {
        await tx(async (db) => {
          const s = await q1<Schedule>(sql`SELECT * FROM recurring_invoices WHERE id = ${id} AND status = 'active' FOR UPDATE SKIP LOCKED`, db);
          if (!s) return;
          await runOnce(db, s);
          made++;
        });
      } catch (e) {
        // Couldn't make it (deal deleted, creator gone, no items…): pause with the reason, so nobody is billed twice later.
        await q(sql`UPDATE recurring_invoices SET status = 'paused', last_error = ${e instanceof Error ? e.message : String(e)} WHERE id = ${id}`);
      }
    }
  }
  return made;
}

export async function recurringRoutes(app: FastifyInstance) {
  /** Schedules the user may see (optionally of one deal or made from one invoice). */
  app.get('/recurring-invoices', async (req) => {
    const ctx = ctxOf(req);
    const query = req.query as { dealId?: string; sourceId?: string };
    const rows = await q(sql`SELECT ${FIELDS} FROM recurring_invoices r JOIN deals d ON d.id = r.deal_id AND d.deleted_at IS NULL
      LEFT JOIN users u ON u.id = r.created_by
      WHERE r.workspace_id = ${ctx.workspaceId} AND ${scopeWhere(ctx, 'deal', 'view', 'd')}
        ${query.dealId ? sql`AND r.deal_id = ${Number(query.dealId)}` : sql``} ${query.sourceId ? sql`AND r.source_id = ${Number(query.sourceId)}` : sql``}
      ORDER BY (r.status = 'ended'), r.next_run, r.id LIMIT 200`);
    // canEdit: may pause/resume/stop (edit rights on the deal); owner and visibility stay on the server.
    return { data: camelAll(rows.map((r) => { const { owner_id, visibility, ...rest } = r as Record<string, unknown> & { owner_id: number; visibility: string }; return { ...rest, can_edit: canOnRecord(ctx, 'deal', 'edit', { owner_id, visibility }) }; })) };
  });

  app.post('/recurring-invoices', async (req, reply) => {
    const ctx = ctxOf(req);
    const body = parse(recurringCreateSchema, req.body);
    const row = await tx(async (db) => {
      const src = await q1<Doc>(sql`SELECT * FROM documents WHERE id = ${body.sourceId} AND workspace_id = ${ctx.workspaceId}`, db);
      if (!src) throw notFound('Invoice');
      await loadDeal(db, ctx, src.deal_id, 'edit');
      if (src.kind !== 'invoice') throw badRequest('Only invoices can repeat');
      if (src.status === 'void') throw conflict('A void invoice can’t be repeated');
      const items = asItems(await q(sql`SELECT * FROM document_items WHERE document_id = ${src.id} ORDER BY sort, id`, db));
      if (!items.length) throw badRequest('Add at least one item to the invoice first');
      if (body.startOn < new Date().toISOString().slice(0, 10)) throw badRequest('Start today or later', { startOn: 'Start today or later' });
      const r = await q1<{ id: number }>(sql`INSERT INTO recurring_invoices (workspace_id, deal_id, source_id, every_months, start_on, next_run, ends_after, mode,
          email_to, message, currency, bill_to_name, bill_to_details, notes, items, created_by)
        VALUES (${ctx.workspaceId}, ${src.deal_id}, ${src.id}, ${body.everyMonths}, ${body.startOn}, ${body.startOn}, ${body.endsAfter}, ${body.mode},
          ${body.emailTo}, ${body.message}, ${src.currency}, ${src.bill_to_name}, ${src.bill_to_details}, ${src.notes}, ${JSON.stringify(items)}, ${ctx.userId})
        RETURNING id`, db);
      await audit(db, ctx, 'deal', src.deal_id, 'recurring_created', { document: { id: src.id, number: src.number }, everyMonths: body.everyMonths, startOn: body.startOn, mode: body.mode });
      return r!;
    });
    const out = await q1(sql`SELECT ${FIELDS} FROM recurring_invoices r JOIN deals d ON d.id = r.deal_id LEFT JOIN users u ON u.id = r.created_by WHERE r.id = ${row.id}`);
    return reply.code(201).send(camel(out!));
  });

  /** Pause, resume or end a schedule. Resuming skips dates that passed while it was paused. */
  app.patch<{ Params: { id: string } }>('/recurring-invoices/:id', async (req) => {
    const ctx = ctxOf(req);
    const body = parse(recurringUpdateSchema, req.body);
    await tx(async (db) => {
      const s = await q1<Schedule>(sql`SELECT * FROM recurring_invoices WHERE id = ${Number(req.params.id)} AND workspace_id = ${ctx.workspaceId} FOR UPDATE`, db);
      if (!s) throw notFound('Schedule');
      await loadDeal(db, ctx, s.deal_id, 'edit');
      if (s.status === 'ended') throw conflict('This schedule has ended; set up a new one from an invoice');
      if (body.status === 'active') {
        // Next date on or after today, on the schedule's rhythm.
        const k = await q1<{ k: number }>(sql`SELECT min(k)::int AS k FROM generate_series(${s.period}, ${s.period} + 1200) k
          WHERE (${s.start_on}::date + make_interval(months => ${s.every_months} * k))::date >= current_date`, db);
        await q(sql`UPDATE recurring_invoices SET status = 'active', last_error = NULL, period = ${k!.k},
            next_run = (start_on + make_interval(months => every_months * ${k!.k}))::date WHERE id = ${s.id}`, db);
      } else {
        await q(sql`UPDATE recurring_invoices SET status = ${body.status} WHERE id = ${s.id}`, db);
      }
      await audit(db, ctx, 'deal', s.deal_id, 'recurring_updated', { schedule: s.id, status: [s.status, body.status] });
    });
    return camel((await q1(sql`SELECT ${FIELDS} FROM recurring_invoices r JOIN deals d ON d.id = r.deal_id LEFT JOIN users u ON u.id = r.created_by WHERE r.id = ${Number(req.params.id)}`, pool))!);
  });
}
