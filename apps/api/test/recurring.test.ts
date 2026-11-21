import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.ts';
import { runRecurringInvoices } from '../src/routes/recurring.ts';
import { getApp, inviteUser, signup } from './helpers.ts';

afterAll(async () => { await (await getApp()).close(); await pool.end(); });

const today = new Date().toISOString().slice(0, 10);
const addMonths = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); const day = x.getUTCDate(); x.setUTCDate(1); x.setUTCMonth(x.getUTCMonth() + n);
  const last = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate(); x.setUTCDate(Math.min(day, last)); return x.toISOString().slice(0, 10); };

async function invoice(c: any) {
  const deal = (await c.post('/deals', { title: 'Maintenance contract' })).body;
  await c.put(`/deals/${deal.id}/line-items`, { items: [{ name: 'Monthly maintenance', unitPrice: '450', quantity: 1, unit: 'month', taxRate: 10 }] });
  const inv = (await c.post(`/deals/${deal.id}/documents`, { kind: 'invoice' })).body;
  return { deal, inv: (await c.post(`/documents/${inv.id}/status`, { status: 'sent' })).body };
}
const invoicesOf = async (dealId: number) => (await pool.query(`SELECT id, number, status, total, created_at FROM documents WHERE deal_id = $1 AND kind = 'invoice' ORDER BY id`, [dealId])).rows;

describe('recurring invoices', () => {
  it('makes an invoice on each date (drafts), catching up missed months, until it has made N', async () => {
    const { c } = await signup();
    const { deal, inv } = await invoice(c);
    const s = await c.post('/recurring-invoices', { sourceId: inv.id, everyMonths: 1, startOn: today, endsAfter: 3, mode: 'draft' });
    expect(s.status).toBe(201);
    expect(s.body).toMatchObject({ everyMonths: 1, nextRun: today, runs: 0, status: 'active', mode: 'draft', amount: '495.00', dealTitle: 'Maintenance contract' });

    expect(await runRecurringInvoices()).toBe(1);
    expect(await runRecurringInvoices()).toBe(0); // not twice the same day
    let list = (await c.get(`/recurring-invoices?dealId=${deal.id}`)).body.data;
    expect(list[0]).toMatchObject({ runs: 1, nextRun: addMonths(today, 1) });
    const made = (await invoicesOf(deal.id)).at(-1);
    expect(made).toMatchObject({ status: 'draft', total: '495.00' });

    // Two months later (the server was off): both missed months are made, then the schedule ends after 3.
    expect(await runRecurringInvoices(addMonths(today, 2))).toBe(2);
    list = (await c.get(`/recurring-invoices?dealId=${deal.id}`)).body.data;
    expect(list[0]).toMatchObject({ runs: 3, status: 'ended' });
    expect(await runRecurringInvoices(addMonths(today, 6))).toBe(0);
    expect((await invoicesOf(deal.id))).toHaveLength(4); // the original + 3
    const notes = (await pool.query(`SELECT title, body FROM notifications WHERE kind = 'document' AND entity_id = $1 ORDER BY id`, [deal.id])).rows;
    expect(notes.at(-1).body).toMatch(/last one of the schedule/);
    expect((await c.patch(`/recurring-invoices/${list[0].id}`, { status: 'active' })).status).toBe(409); // ended
  });

  it('"send" mode numbers and emails each invoice; pause skips, resume continues from today', async () => {
    const { c } = await signup();
    const { deal, inv } = await invoice(c);
    expect((await c.post('/recurring-invoices', { sourceId: inv.id, everyMonths: 3, startOn: today, mode: 'send' })).status).toBe(400); // who to email?
    const s = (await c.post('/recurring-invoices', { sourceId: inv.id, everyMonths: 3, startOn: today, mode: 'send', emailTo: ['ap@umbrella.test'] })).body;
    await runRecurringInvoices();
    const made = (await invoicesOf(deal.id)).at(-1);
    expect(made.status).toBe('sent');
    expect(made.number).toMatch(/^INV-\d{4}$/);
    const mail = (await pool.query(`SELECT payload FROM jobs WHERE type = 'email.send' ORDER BY id DESC LIMIT 1`)).rows[0].payload;
    expect(mail.to).toBe('ap@umbrella.test');
    expect(mail.subject).toBe(`Invoice ${made.number} from Admin Inc`);
    expect(JSON.stringify(mail)).toContain('View and pay online');

    // Paused over its next date: nothing is made; resuming picks the next date on or after today.
    await c.patch(`/recurring-invoices/${s.id}`, { status: 'paused' });
    expect(await runRecurringInvoices(addMonths(today, 4))).toBe(0);
    await pool.query(`UPDATE recurring_invoices SET start_on = start_on - interval '6 months', next_run = next_run - interval '6 months' WHERE id = $1`, [s.id]);
    const resumed = (await c.patch(`/recurring-invoices/${s.id}`, { status: 'active' })).body;
    expect(resumed.status).toBe('active');
    expect(resumed.nextRun >= today).toBe(true);
    expect(resumed.runs).toBe(1); // skipped dates don't count as made
  });

  it('checks the invoice and permissions; a deleted deal pauses the schedule with the reason', async () => {
    const { c } = await signup();
    const { deal, inv } = await invoice(c);
    const quoteDeal = (await c.post('/deals', { title: 'Q' })).body;
    await c.put(`/deals/${quoteDeal.id}/line-items`, { items: [{ name: 'X', unitPrice: '1', quantity: 1, unit: 'pcs' }] });
    const quote = (await c.post(`/deals/${quoteDeal.id}/documents`, { kind: 'quote' })).body;
    expect((await c.post('/recurring-invoices', { sourceId: quote.id, everyMonths: 1, startOn: today, mode: 'draft' })).status).toBe(400);
    expect((await c.post('/recurring-invoices', { sourceId: inv.id, everyMonths: 5, startOn: today, mode: 'draft' })).status).toBe(400);
    expect((await c.post('/recurring-invoices', { sourceId: inv.id, everyMonths: 1, startOn: '2020-01-01', mode: 'draft' })).status).toBe(400);
    const viewer = await inviteUser(c, 'Viewer');
    expect((await viewer.c.post('/recurring-invoices', { sourceId: inv.id, everyMonths: 1, startOn: today, mode: 'draft' })).status).toBe(403);
    const other = await signup();
    expect((await other.c.post('/recurring-invoices', { sourceId: inv.id, everyMonths: 1, startOn: today, mode: 'draft' })).status).toBe(404);

    const s = (await c.post('/recurring-invoices', { sourceId: inv.id, everyMonths: 1, startOn: today, mode: 'draft' })).body;
    expect((await viewer.c.get('/recurring-invoices')).body.data.map((x: any) => x.id)).toContain(s.id); // viewers see
    expect((await viewer.c.patch(`/recurring-invoices/${s.id}`, { status: 'paused' })).status).toBe(403);
    expect((await other.c.get('/recurring-invoices')).body.data).toHaveLength(0);
    await pool.query(`UPDATE deals SET deleted_at = now() WHERE id = $1`, [deal.id]);
    await runRecurringInvoices();
    expect((await pool.query('SELECT status, last_error FROM recurring_invoices WHERE id = $1', [s.id])).rows[0]).toEqual({ status: 'paused', last_error: 'The deal was deleted.' });
  });
});
