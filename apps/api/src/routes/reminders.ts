/**
 * Payment reminders for sent invoices with a balance (Settings → Quotes & invoices → Payment reminders).
 *
 * Steps: N days before the due date, on it, and up to three "N days after". The worker sends at most one step per
 * invoice per day, after 9:00 in the workspace's time zone, only for steps of the last 3 days (turning reminders on
 * doesn't flood old invoices), and never the same step twice (invoice_reminders is UNIQUE per step). A reminder goes by
 * email to the addresses the invoice was last emailed to (PDF attached, "View and pay" button) and, when enabled, to the
 * Telegram bot chats of the deal's contacts. Paid, void or "don't remind" invoices get none. Anyone who may edit the
 * deal can also send one now.
 */
import type { FastifyInstance } from 'fastify';
import { ct, ctLabel, customerDate, documentRemindersSchema, moneyCompare, moneyMinus, type CustomerLanguage, type ReminderSettings } from '@crm/shared';
import { pool, q, q1, sql, tx, type Db } from '../db/index.ts';
import { audit } from '../lib/audit.ts';
import { systemCtx, type Ctx } from '../lib/context.ts';
import { formatMoney } from '../lib/documentPdf.ts';
import { AppError, conflict } from '../lib/errors.ts';
import { ctxOf } from '../lib/http.ts';
import { documentMail, queueMail, workspaceSender } from '../lib/mailer.ts';
import { parse } from '../lib/validate.ts';
import { documentSettings, ensureLink, loadDoc, renderPdf, type Doc } from './documents.ts';
import { sendWaTemplate } from '../inbox/waNotify.ts';

type InvoiceRow = Doc & { email_to: string[]; reminders_off: boolean };
interface Step { step: string; date: string; label: string }

const addDays = (d: string, n: number) => { const t = new Date(`${d.slice(0, 10)}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

/** The reminder steps of an invoice, in date order. */
export function reminderSteps(s: Pick<ReminderSettings, 'beforeDays' | 'onDue' | 'afterDays'> & Partial<ReminderSettings>, dueDate: string): Step[] {
  const out: Step[] = [];
  if (s.beforeDays) out.push({ step: `before:${s.beforeDays}`, date: addDays(dueDate, -s.beforeDays), label: `${s.beforeDays} day${s.beforeDays === 1 ? '' : 's'} before the due date` });
  if (s.onDue) out.push({ step: 'due', date: dueDate.slice(0, 10), label: 'on the due date' });
  for (const n of s.afterDays) out.push({ step: `after:${n}`, date: addDays(dueDate, n), label: `${n} day${n === 1 ? '' : 's'} overdue` });
  return out;
}

/** The deal's contacts (primary first). */
const dealContactIds = async (db: Db, dealId: number) => (await q<{ id: number }>(sql`SELECT dc.contact_id AS id FROM deal_contacts dc
  JOIN contacts c ON c.id = dc.contact_id AND c.deleted_at IS NULL WHERE dc.deal_id = ${dealId} ORDER BY dc.is_primary DESC, c.id`, db)).map((r) => Number(r.id));

/** Telegram bot chats of the deal's contacts (where a reminder can go besides email). */
async function telegramChats(db: Db, dealId: number) {
  return q<{ id: number; contact_name: string }>(sql`SELECT cv.id, trim(concat_ws(' ', ct.first_name, ct.last_name)) AS contact_name
    FROM deal_contacts dc JOIN contacts ct ON ct.id = dc.contact_id AND ct.deleted_at IS NULL
    JOIN conversations cv ON cv.contact_id = ct.id AND cv.kind = 'direct'
    JOIN channels ch ON ch.id = cv.channel_id AND ch.kind = 'telegram_bot' AND ch.status = 'active'
    WHERE dc.deal_id = ${dealId} ORDER BY cv.last_message_at DESC LIMIT 5`, db);
}

/**
 * Sends one reminder now and records it (step must be new for this invoice — returns false if it was already sent).
 * `by`: the team member sending it by hand, or null (automatic).
 */
async function sendReminder(db: Db, doc: InvoiceRow, step: string, by: Ctx | null, useTelegram: boolean, today: string): Promise<boolean> {
  const balance = moneyMinus(doc.total, doc.paid_amount);
  const s = await documentSettings(doc.workspace_id, db);
  const chats = useTelegram ? await telegramChats(db, doc.deal_id) : [];
  const contactIds = await dealContactIds(db, doc.deal_id);
  const waBase = { workspaceId: doc.workspace_id, setting: s.reminders.whatsapp, contactIds, title: doc.bill_to_name || 'Customer' };
  const waReach = await sendWaTemplate(db, { ...waBase, values: {}, senderName: '', dryRun: true });
  if (!doc.email_to.length && !chats.length && !waReach) return false;
  const row = await q1<{ id: number }>(sql`INSERT INTO invoice_reminders (workspace_id, document_id, step, sent_to, chats, balance, sent_by)
    VALUES (${doc.workspace_id}, ${doc.id}, ${step}, ${doc.email_to}, ${chats.length}, ${balance}, ${by?.userId ?? null})
    ON CONFLICT (document_id, step) DO NOTHING RETURNING id`, db);
  if (!row) return false;

  const lang: CustomerLanguage = s.customerLanguage;
  const vars = { number: doc.number ?? '', amount: formatMoney(balance, doc.currency), date: customerDate(lang, doc.due_date), company: s.sellerName };
  const due = doc.due_date!.slice(0, 10);
  const what = due > today ? ct(lang, 'reminderBefore', vars) : due === today ? ct(lang, 'reminderDue', vars) : `${ct(lang, 'reminderAfter', vars)} ${ct(lang, 'reminderPaidAlready')}`;
  const link = await ensureLink(db, doc);
  const hello = (name: string) => (name.trim() ? ct(lang, 'reminderHello', { name: name.trim() }) : '');
  const owner = await q1<{ name: string; email: string }>(sql`SELECT u.name, u.email FROM deals d JOIN users u ON u.id = d.owner_id WHERE d.id = ${doc.deal_id}`, db);

  if (doc.email_to.length) {
    const pdfCtx = by ?? systemCtx(doc.workspace_id, 0);
    const pdf = await renderPdf(pdfCtx, doc, db);
    await queueMail({
      ...documentMail({
        to: doc.email_to, replyTo: by?.email || owner?.email || '', subject: ct(lang, 'reminderSubject', vars),
        message: [hello(doc.bill_to_name), what, '', ct(lang, 'reminderThanks'), s.sellerName].filter((l, i) => l || i === 2).join('\n'),
        sender: by?.userName ?? owner?.name ?? s.sellerName, workspace: s.sellerName,
        pdf: { filename: pdf.filename, base64: pdf.buffer.toString('base64') }, button: { label: ctLabel(lang, 'viewPay'), url: link },
      }),
      fromName: await workspaceSender(doc.workspace_id, db),
    }, db, { workspaceId: doc.workspace_id });
  }
  for (const c of chats) {
    const text = [hello(c.contact_name), what, ct(lang, 'reminderLink', { url: link }), ct(lang, 'reminderThanks')].filter(Boolean).join('\n\n');
    const m = await q1<{ id: number }>(sql`INSERT INTO messages (workspace_id, conversation_id, direction, sender_name, author_id, body, status)
      VALUES (${doc.workspace_id}, ${c.id}, 'out', ${by?.userName ?? s.sellerName}, ${by?.userId ?? null}, ${text}, 'pending') RETURNING id`, db);
    await q(sql`INSERT INTO jobs (type, payload) VALUES ('inbox.send', ${JSON.stringify({ messageId: m!.id })})`, db);
  }
  const wa = waReach ? await sendWaTemplate(db, {
    ...waBase, senderName: by?.userName ?? s.sellerName, authorId: by?.userId ?? null,
    values: { name: doc.bill_to_name, number: doc.number ?? '', amount: vars.amount, dueDate: vars.date, link, company: s.sellerName },
  }) : 0;
  if (wa) await q(sql`UPDATE invoice_reminders SET whatsapp = ${wa} WHERE id = ${row.id}`, db);
  const ctx = by ?? systemCtx(doc.workspace_id, 0);
  await audit(db, ctx, 'deal', doc.deal_id, 'invoice_reminder', { document: { id: doc.id, number: doc.number }, step, to: doc.email_to, chats: chats.length, whatsapp: wa, balance },
    by ? 'user' : 'automation');
  return true;
}

/**
 * Worker: sends the reminders that are due. `now` replaces the clock (tests). Returns how many were sent.
 */
export async function runPaymentReminders(now: Date = new Date()): Promise<number> {
  const rows = await q<InvoiceRow & { today: string; hour: number; reminders: unknown }>(sql`
    SELECT d.*, to_char((${now}::timestamptz AT TIME ZONE w.timezone)::date, 'YYYY-MM-DD') AS today,
      extract(hour FROM ${now}::timestamptz AT TIME ZONE w.timezone)::int AS hour, w.settings->'documents'->'reminders' AS reminders
    FROM documents d JOIN workspaces w ON w.id = d.workspace_id JOIN deals dl ON dl.id = d.deal_id AND dl.deleted_at IS NULL
    WHERE d.kind = 'invoice' AND d.status = 'sent' AND d.due_date IS NOT NULL AND NOT d.reminders_off AND d.total > d.paid_amount
      AND (w.settings->'documents'->'reminders'->>'enabled') = 'true'
      AND NOT EXISTS (SELECT 1 FROM invoice_reminders r WHERE r.document_id = d.id AND r.sent_at > ${now}::timestamptz - interval '20 hours')
    ORDER BY d.id LIMIT 500`);
  let sent = 0;
  for (const d of rows) {
    if (d.hour < 9) continue;
    const s = (await documentSettings(d.workspace_id)).reminders;
    const windowStart = addDays(d.today, -3);
    const due = reminderSteps(s, d.due_date!).filter((x) => x.date <= d.today && x.date >= windowStart && (!d.issue_date || x.date >= String(d.issue_date).slice(0, 10)));
    const step = due.at(-1);
    if (!step) continue;
    try {
      await tx(async (db) => {
        const already = await q1(sql`SELECT 1 FROM invoice_reminders WHERE document_id = ${d.id} AND step = ${step.step}`, db);
        if (already) return;
        // A later step already went out (e.g. after catching up): don't send an earlier one.
        const later = reminderSteps(s, d.due_date!).filter((x) => x.date > step.date).map((x) => x.step);
        if (later.length && await q1(sql`SELECT 1 FROM invoice_reminders WHERE document_id = ${d.id} AND step = ANY(${later})`, db)) return;
        if (await sendReminder(db, d, step.step, null, s.telegram, d.today)) sent++;
      });
    } catch { /* one invoice failing (e.g. PDF) doesn't stop the others; it's tried again next round */ }
  }
  return sent;
}

export async function reminderRoutes(app: FastifyInstance) {
  /** The invoice's reminder status: settings, next step, recipients, and what was sent. */
  app.get<{ Params: { id: string } }>('/documents/:id/reminders', async (req) => {
    const ctx = ctxOf(req);
    const { doc: d } = await loadDoc(pool, ctx, Number(req.params.id), 'view');
    const doc = d as InvoiceRow;
    const s = (await documentSettings(ctx.workspaceId)).reminders;
    const today = (await q1<{ today: string }>(sql`SELECT to_char((now() AT TIME ZONE timezone)::date, 'YYYY-MM-DD') AS today FROM workspaces WHERE id = ${ctx.workspaceId}`))!.today;
    const sent = await q(sql`SELECT r.id, r.step, r.sent_to, r.chats, r.whatsapp, r.balance::text, r.sent_at, u.name AS sent_by_name
      FROM invoice_reminders r LEFT JOIN users u ON u.id = r.sent_by WHERE r.document_id = ${doc.id} ORDER BY r.sent_at DESC LIMIT 20`);
    const chats = s.telegram ? (await telegramChats(pool, doc.deal_id)).length : 0;
    const whatsapp = await sendWaTemplate(pool, { workspaceId: ctx.workspaceId, setting: s.whatsapp, contactIds: await dealContactIds(pool, doc.deal_id), values: {}, senderName: '', title: '', dryRun: true });
    const owed = doc.kind === 'invoice' && doc.status === 'sent' && moneyCompare(doc.total, doc.paid_amount) > 0;
    const done = new Set(sent.map((r) => (r as { step: string }).step));
    const next = owed && s.enabled && !doc.reminders_off && doc.due_date
      ? reminderSteps(s, doc.due_date).find((x) => !done.has(x.step) && x.date >= today) ?? null : null;
    return {
      enabled: s.enabled, off: doc.reminders_off, owed, emailTo: doc.email_to, chats, telegram: s.telegram, whatsapp,
      next: next && (doc.email_to.length || chats || whatsapp) ? next : null,
      sent: sent.map((r) => { const x = r as Record<string, unknown>; return { id: x.id, step: x.step, sentTo: x.sent_to, chats: x.chats, whatsapp: x.whatsapp, balance: x.balance, sentAt: x.sent_at, sentByName: x.sent_by_name }; }),
    };
  });

  /** Don't remind (or remind again) for this invoice. */
  app.post<{ Params: { id: string } }>('/documents/:id/reminders', async (req) => {
    const ctx = ctxOf(req);
    const body = parse(documentRemindersSchema, req.body);
    await tx(async (db) => {
      const { doc } = await loadDoc(db, ctx, Number(req.params.id), 'edit', true);
      if (doc.kind !== 'invoice') throw conflict('Only invoices have payment reminders');
      await q(sql`UPDATE documents SET reminders_off = ${body.off} WHERE id = ${doc.id}`, db);
      await audit(db, ctx, 'deal', doc.deal_id, body.off ? 'invoice_reminders_off' : 'invoice_reminders_on', { document: { id: doc.id, number: doc.number } });
    });
    return { ok: true };
  });

  /** Send a reminder now (also when automatic reminders are off). */
  app.post<{ Params: { id: string } }>('/documents/:id/remind', async (req) => {
    const ctx = ctxOf(req);
    await tx(async (db) => {
      const { doc } = await loadDoc(db, ctx, Number(req.params.id), 'edit', true);
      const d = doc as InvoiceRow;
      if (d.kind !== 'invoice' || d.status !== 'sent' || moneyCompare(d.total, d.paid_amount) <= 0) throw conflict('Only sent invoices with a balance get reminders');
      if (!d.due_date) throw conflict('This invoice has no due date');
      const recent = await q1(sql`SELECT 1 FROM invoice_reminders WHERE document_id = ${d.id} AND sent_at > now() - interval '10 minutes'`, db);
      if (recent) throw new AppError(429, 'TOO_SOON', 'A reminder was just sent. Wait a few minutes before sending another.');
      const s = (await documentSettings(ctx.workspaceId, db)).reminders;
      const today = (await q1<{ today: string }>(sql`SELECT to_char((now() AT TIME ZONE timezone)::date, 'YYYY-MM-DD') AS today FROM workspaces WHERE id = ${ctx.workspaceId}`, db))!.today;
      const ok = await sendReminder(db, d, `manual:${new Date().toISOString()}`, ctx, s.telegram, today);
      if (!ok) throw new AppError(422, 'NO_RECIPIENT', 'Nobody to remind: email the invoice to the customer first, link their Telegram chat to a contact on the deal, or add a phone number for WhatsApp.');
    });
    return { ok: true };
  });
}
