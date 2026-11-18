import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.ts';
import { decodeKhqr } from '../src/lib/khqr.ts';
import { getApp, inviteUser, signup } from './helpers.ts';

afterAll(async () => { await (await getApp()).close(); await pool.end(); });

const KHQR = { enabled: true, accountId: 'sreng_sokheng@aclb', merchantName: 'Acme Robotics', city: 'Phnom Penh', accountType: 'individual', validDays: 7 };
const settings = (khqr: Record<string, unknown>) => ({ companyDetails: '', footer: '', quotePrefix: 'Q-', invoicePrefix: 'INV-', quoteValidDays: 30, paymentTermsDays: 14, khqr });

async function sentInvoice(c: any, currency = 'USD', price = '1250.50') {
  const deal = (await c.post('/deals', { title: 'Arms', currency })).body;
  await c.put(`/deals/${deal.id}/line-items`, { items: [{ name: 'Robot arm', unitPrice: price, quantity: 1, unit: 'pcs' }] });
  const inv = (await c.post(`/deals/${deal.id}/documents`, { kind: 'invoice' })).body;
  const draft = (await c.get(`/documents/${inv.id}/khqr`)).body;
  const sent = (await c.post(`/documents/${inv.id}/status`, { status: 'sent' })).body;
  return { inv: sent, draft };
}

describe('KHQR on invoices', () => {
  it('shows a QR for the balance due on sent KHR/USD invoices once an admin set it up', async () => {
    const { c } = await signup();
    // Not set up yet: explained.
    const before = await sentInvoice(c);
    expect((await c.get(`/documents/${before.inv.id}/khqr`)).body).toMatchObject({ available: false, reason: 'not_configured' });

    // Settings are checked: banks show the name as typed, so only plain characters; the account ID has a format.
    expect((await c.put('/settings/documents', settings({ ...KHQR, merchantName: 'ក្រុមហ៊ុន' }))).status).toBe(400);
    expect((await c.put('/settings/documents', settings({ ...KHQR, accountId: 'not an id' }))).status).toBe(400);
    expect((await c.put('/settings/documents', settings({ ...KHQR, merchantName: 'A name far too long for KHQR' }))).status).toBe(400);
    expect((await c.put('/settings/documents', settings({ ...KHQR, accountId: '' }))).status).toBe(400); // on, but no account
    expect((await c.put('/settings/documents', settings(KHQR))).status).toBe(200);
    expect((await c.get('/settings/documents')).body.khqr).toMatchObject(KHQR);

    const { inv, draft } = await sentInvoice(c);
    expect(draft).toMatchObject({ available: false, reason: 'not_sent' });
    const k = (await c.get(`/documents/${inv.id}/khqr`)).body;
    expect(k).toMatchObject({ available: true, amount: '1250.50', currency: 'USD', accountId: 'sreng_sokheng@aclb', merchantName: 'Acme Robotics' });
    const d = decodeKhqr(k.payload);
    expect(d.valid).toBe(true);
    expect(d.fields).toMatchObject({ '01': '12', '53': '840', '54': '1250.50', '59': 'Acme Robotics', '60': 'Phnom Penh', '62': `01${String(inv.number.length).padStart(2, '0')}${inv.number}` });
    const expires = Number(d.fields['99'].slice(-13));
    expect(expires - Date.now()).toBeGreaterThan(6.9 * 86_400_000); // valid for the configured 7 days
    expect(new Date(k.expiresAt).getTime()).toBe(expires);

    // After a part payment, the QR asks for what's left; once paid, there's none.
    await c.post(`/documents/${inv.id}/payments`, { amount: '1000', paidOn: '2026-11-18', method: 'KHQR' });
    expect((await c.get(`/documents/${inv.id}/khqr`)).body).toMatchObject({ available: true, amount: '250.50' });
    await c.post(`/documents/${inv.id}/payments`, { amount: '250.50', paidOn: '2026-11-18', method: 'Cash' });
    expect((await c.get(`/documents/${inv.id}/khqr`)).body).toMatchObject({ available: false, reason: 'paid' });

    // Riel: whole riel, currency 116.
    const khr = await sentInvoice(c, 'KHR', '412000');
    const kk = (await c.get(`/documents/${khr.inv.id}/khqr`)).body;
    expect(decodeKhqr(kk.payload).fields).toMatchObject({ '53': '116', '54': '412000' });

    // Merchant accounts carry the merchant ID and bank.
    await c.put('/settings/documents', settings({ ...KHQR, accountType: 'merchant', accountId: 'acme@abaa', merchantId: '1234567', acquiringBank: 'ABA Bank' }));
    const m = decodeKhqr((await c.get(`/documents/${khr.inv.id}/khqr`)).body.payload);
    expect(m.fields['30']).toBe('0009acme@abaa010712345670208ABA Bank');
  });

  it('prints the QR on the invoice PDF; other currencies and quotes get none; permissions apply', async () => {
    const { c } = await signup();
    await c.put('/settings/documents', settings(KHQR));
    const { inv } = await sentInvoice(c);
    const pdf = (await c.download(`/documents/${inv.id}/pdf`)).body.toString('latin1');
    expect(pdf).toContain('PAY WITH KHQR');
    expect(pdf).toContain('Scan with any Bakong member bank app');
    expect((pdf.match(/ re f/g) ?? []).length).toBeGreaterThan(100); // the QR's squares

    // A quote, and a draft, print no QR.
    const deal = (await c.post('/deals', { title: 'Q' })).body;
    await c.put(`/deals/${deal.id}/line-items`, { items: [{ name: 'X', unitPrice: '10', quantity: 1, unit: 'pcs' }] });
    const quote = (await c.post(`/deals/${deal.id}/documents`, { kind: 'quote' })).body;
    expect((await c.download(`/documents/${quote.id}/pdf`)).body.toString('latin1')).not.toContain('PAY WITH KHQR');
    expect((await c.get(`/documents/${quote.id}/khqr`)).body).toMatchObject({ available: false, reason: 'not_invoice' });

    // A currency KHQR doesn't support.
    await pool.query(`UPDATE documents SET currency = 'EUR' WHERE id = $1`, [inv.id]);
    expect((await c.get(`/documents/${inv.id}/khqr`)).body).toMatchObject({ available: false, reason: 'currency' });

    // Only admins change the settings; other workspaces can't read the QR; viewers can.
    const rep = await inviteUser(c, 'Sales rep');
    expect((await rep.c.put('/settings/documents', settings({ ...KHQR, accountId: 'thief@bank' }))).status).toBe(403);
    const other = await signup();
    expect((await other.c.get(`/documents/${inv.id}/khqr`)).status).toBe(404);
    const viewer = await inviteUser(c, 'Viewer');
    expect((await viewer.c.get(`/documents/${inv.id}/khqr`)).status).toBe(200);
  });
});
