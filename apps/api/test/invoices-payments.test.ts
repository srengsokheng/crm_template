import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { processJobs, processOutbox } from '../src/automation/engine.ts';
import { pool } from '../src/db/pool.ts';
import { outbox, setTransport } from '../src/lib/mailer.ts';
import { getApp, inviteUser, signup, type Client } from './helpers.ts';

afterAll(async () => { await (await getApp()).close(); await pool.end(); });
beforeEach(() => { outbox.length = 0; setTransport(null); });
const drain = async () => { for (let n = 0; n < 20; n++) if (!((await processJobs(50)) + (await processOutbox()))) return; };

/** A sent invoice for 1,000.00 on a new deal. */
async function sentInvoice(c: Client, title = 'Robots', currency?: string) {
  const deal = (await c.post('/deals', { title, ...(currency ? { currency } : {}) })).body;
  await c.put(`/deals/${deal.id}/line-items`, { items: [{ name: 'Picker', unitPrice: '1000', quantity: 1, unit: 'pcs' }] });
  const inv = (await c.post(`/deals/${deal.id}/documents`, { kind: 'invoice' })).body;
  const sent = (await c.post(`/documents/${inv.id}/status`, { status: 'sent' })).body;
  return { deal, inv: sent };
}

describe('invoice payments', () => {
  it('records partial payments, becomes paid when covered, refuses overpayment, removing a payment reopens it', async () => {
    const { c } = await signup();
    const { deal, inv } = await sentInvoice(c);
    const p1 = await c.post(`/documents/${inv.id}/payments`, { amount: '400', paidOn: '2026-11-10', method: 'Bank transfer', note: 'First half' });
    expect(p1.status, JSON.stringify(p1.body)).toBe(201);
    expect(p1.body).toMatchObject({ status: 'sent', paidAmount: '400.00', balance: '600.00' });
    expect(p1.body.payments).toEqual([expect.objectContaining({ amount: '400.00', paidOn: '2026-11-10', method: 'Bank transfer', note: 'First half' })]);

    const over = await c.post(`/documents/${inv.id}/payments`, { amount: '600.01', paidOn: '2026-11-11' });
    expect(over.status).toBe(400);
    expect(over.body.error.message).toBe('More than the remaining balance (600.00 USD)');
    expect((await c.post(`/documents/${inv.id}/payments`, { amount: '0', paidOn: '2026-11-11' })).status).toBe(400);
    expect((await c.post(`/documents/${inv.id}/status`, { status: 'void' })).status).toBe(409); // has payments

    const p2 = (await c.post(`/documents/${inv.id}/payments`, { amount: '600', paidOn: '2026-11-12' })).body;
    expect(p2).toMatchObject({ status: 'paid', paidAmount: '1000.00', balance: '0.00' });
    expect((await c.post(`/documents/${inv.id}/payments`, { amount: '1', paidOn: '2026-11-12' })).status).toBe(409);

    // Deleting a payment reopens the invoice.
    const back = (await c.del(`/documents/${inv.id}/payments/${p2.payments[1].id}`)).body;
    expect(back).toMatchObject({ status: 'sent', paidAmount: '400.00', balance: '600.00' });
    // "Mark as paid" records the rest as a payment.
    const marked = (await c.post(`/documents/${inv.id}/status`, { status: 'paid' })).body;
    expect(marked.payments.map((p: any) => [p.amount, p.method])).toEqual([['400.00', 'Bank transfer'], ['600.00', 'Marked as paid']]);
    const hist = (await c.get(`/history/deal/${deal.id}`)).body.data.map((h: any) => h.action);
    expect(hist).toEqual(expect.arrayContaining(['invoice_payment', 'invoice_payment_removed', 'invoice_paid']));

    // The PDF shows what's been paid and the balance (here: none left).
    const pdf = (await c.download(`/documents/${inv.id}/pdf`)).body.toString('latin1');
    expect(pdf).toContain('(Balance due)');
    // Quotes don't take payments.
    const q = (await c.post(`/deals/${deal.id}/documents`, { kind: 'quote' })).body;
    expect((await c.post(`/documents/${q.id}/payments`, { amount: '1', paidOn: '2026-11-12' })).status).toBe(400);
  });

  it('lists quotes and invoices across deals with filters and outstanding totals in the base currency', async () => {
    const { c } = await signup();
    const a = await sentInvoice(c, 'Alpha');
    const b = await sentInvoice(c, 'Beta');
    await c.post(`/documents/${b.inv.id}/payments`, { amount: '250', paidOn: '2026-11-10' });
    await c.patch(`/documents/${a.inv.id}`, {}); // sent docs are locked; due date set at send
    const draft = (await c.post(`/deals/${a.deal.id}/documents`, { kind: 'quote' })).body;
    const eur = await sentInvoice(c, 'Gamma', 'EUR'); // no EUR rate yet

    const all = (await c.get('/documents?pageSize=50')).body;
    expect(all.total).toBe(4);
    expect(all.totals).toMatchObject({ outstanding: '1750.00', overdue: '0', overdueCount: 0, missingRates: ['EUR'] });
    expect(all.baseCurrency).toBe('USD');
    const beta = all.data.find((d: any) => d.id === b.inv.id);
    expect(beta).toMatchObject({ dealTitle: 'Beta', balance: '750.00', overdue: false });

    expect((await c.get('/documents?kind=quote')).body.data.map((d: any) => d.id)).toEqual([draft.id]);
    expect((await c.get('/documents?status=unpaid')).body.total).toBe(3);
    expect((await c.get('/documents?q=Alpha')).body.data.map((d: any) => d.dealId).every((id: number) => id === a.deal.id)).toBe(true);
    expect((await c.get('/documents?sort=-balance&kind=invoice')).body.data[0].balance).toBe('1000.00');

    // Add the EUR rate: it now counts. Overdue: move a due date into the past (directly, sent docs are locked).
    await c.post('/exchange-rates', { currency: 'EUR', rate: '1.5', validFrom: '2026-01-01' });
    const { q: dbq, sql } = await import('../src/db/index.ts');
    await dbq(sql`UPDATE documents SET due_date = current_date - 3 WHERE id = ${a.inv.id}`);
    const now = (await c.get('/documents')).body.totals;
    expect(now).toMatchObject({ outstanding: '3250.00', overdue: '1000.00', overdueCount: 1, missingRates: [] });
    expect((await c.get('/documents?status=overdue')).body.data.map((d: any) => d.id)).toEqual([a.inv.id]);
    void eur;
  });

  it('only shows documents of deals the user may see; other workspaces see nothing', async () => {
    const { c } = await signup();
    const rep = await inviteUser(c, 'Sales rep');
    await sentInvoice(c, 'Admin private');
    const mine = (await rep.c.post('/deals', { title: 'Rep deal' })).body;
    await rep.c.put(`/deals/${mine.id}/line-items`, { items: [{ name: 'X', unitPrice: '10', quantity: 1, unit: 'pcs' }] });
    await rep.c.post(`/deals/${mine.id}/documents`, { kind: 'invoice' });
    expect((await rep.c.get('/documents')).body.data.map((d: any) => d.dealTitle)).toEqual(['Rep deal']);
    const other = await signup('Other');
    expect((await other.c.get('/documents')).body.total).toBe(0);
  });
});

describe('emailing quotes and invoices', () => {
  it('sends the PDF to the recipients with Reply-To the sender; a draft is issued first; audited', async () => {
    const { c, email: adminEmail } = await signup();
    const contact = (await c.post('/contacts', { firstName: 'Ada', methods: [{ kind: 'email', value: 'ada@customer.test' }] })).body;
    const deal = (await c.post('/deals', { title: 'Engines', contactIds: [contact.id] })).body;
    await c.put(`/deals/${deal.id}/line-items`, { items: [{ name: 'Engine', unitPrice: '500', quantity: 2, unit: 'pcs' }] });
    const q = (await c.post(`/deals/${deal.id}/documents`, { kind: 'quote' })).body;
    expect((await c.get(`/documents/${q.id}`)).body.suggestedRecipients).toEqual(['ada@customer.test']);

    const r = await c.post(`/documents/${q.id}/email`, { to: ['ada@customer.test', 'cfo@customer.test'], subject: 'Your quote', message: 'Hi Ada,\n\nHere is our offer.\n<b>Thanks</b>' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ status: 'sent', number: 'Q-0001' });
    expect(r.body.lastEmailedAt).toBeTruthy();
    await drain();
    const m = outbox.find((x) => x.subject === 'Your quote')!;
    expect(m.to).toBe('ada@customer.test, cfo@customer.test');
    expect(m.replyTo).toBe(adminEmail);
    expect(m.attachments).toHaveLength(1);
    expect(m.attachments![0]).toMatchObject({ filename: 'Q-0001.pdf', contentType: 'application/pdf' });
    expect(Buffer.from(m.attachments![0].content, 'base64').toString('latin1').startsWith('%PDF-1.4')).toBe(true);
    expect(m.html).toContain('&lt;b&gt;Thanks&lt;/b&gt;'); // the message is escaped
    expect(m.text).toContain('Here is our offer.');
    const hist = (await c.get(`/history/deal/${deal.id}`)).body.data;
    expect(hist.find((h: any) => h.action === 'quote_emailed').changes.to).toEqual(['ada@customer.test', 'cfo@customer.test']);

    // Validation and permissions.
    expect((await c.post(`/documents/${q.id}/email`, { to: [], subject: 'x' })).status).toBe(400);
    expect((await c.post(`/documents/${q.id}/email`, { to: ['not-an-email'], subject: 'x' })).status).toBe(400);
    expect((await c.post(`/documents/${q.id}/email`, { to: ['a@b.test'], subject: 'x\r\nBcc: evil@x.test' })).status).toBe(200);
    await drain();
    expect(outbox.find((x) => x.subject.startsWith('x'))!.subject).toBe('x Bcc: evil@x.test'); // single line
    const viewer = await inviteUser(c, 'Viewer');
    expect((await viewer.c.post(`/documents/${q.id}/email`, { to: ['a@b.test'], subject: 'x' })).status).toBe(403);
    expect((await viewer.c.get(`/documents/${q.id}`)).body.suggestedRecipients).toEqual([]);
  });
});
