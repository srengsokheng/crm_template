import { afterAll, describe, expect, it } from 'vitest';
import { ct, ctLabel, customerDate, customerTexts } from '@crm/shared';
import { pool } from '../src/db/pool.ts';
import { renderDocumentPdf } from '../src/lib/documentPdf.ts';
import { pdfUnicodeString } from '../src/lib/pdfFonts.ts';
import { getApp, signup } from './helpers.ts';

afterAll(async () => { await (await getApp()).close(); await pool.end(); });

/** True when the PDF carries this text for copy & search (its /ActualText or ToUnicode spans). */
const pdfHas = (pdf: Buffer, text: string) => pdf.toString('latin1').includes(pdfUnicodeString(text).slice(5, -1)) || pdf.toString('latin1').includes(text);
const docInput = (lang: 'en' | 'km' | 'both') => ({
  kind: 'invoice' as const, number: 'INV-0042', status: 'sent', currency: 'USD', issueDate: '2026-11-19', dueDate: '2026-12-03', billToName: 'Umbrella Foods', billToDetails: '',
  notes: '', listTotal: '100.00', discount: '0', tax: '0', total: '100.00', paidAmount: '40.00',
  items: [{ name: 'Robot arm', quantity: 1, unit: 'pcs', unitPrice: '100', discountType: null, discountValue: null, taxRate: null, taxIncluded: false, lineTotal: '100.00' }],
  seller: { name: 'Acme', details: '', footer: '' }, lang,
});

describe('customer language (English, Khmer, both)', () => {
  it('texts, labels and dates', () => {
    expect(ct('en', 'invoice')).toBe('Invoice');
    expect(ct('km', 'invoice')).toBe('វិក្កយបត្រ');
    expect(ct('both', 'thanksAccepted')).toBe(ct('km', 'thanksAccepted')); // sentences aren't doubled
    expect(ctLabel('both', 'total')).toBe('សរុប / Total');
    expect(ct('km', 'page', { n: 2, total: 3 })).toBe('ទំព័រ 2 នៃ 3');
    expect(customerDate('en', '2026-11-19')).toBe('Nov 19, 2026');
    expect(customerDate('km', '2026-11-19')).toBe('19 វិច្ឆិកា 2026');
    // Every key has a Khmer text, none left in English by mistake (other than shared names).
    const en = customerTexts('en');
    const km = customerTexts('km');
    expect(Object.keys(km).sort()).toEqual(Object.keys(en).sort());
    for (const k of Object.keys(en) as (keyof typeof en)[]) if (!['downloadPdf', 'payWithKhqr'].includes(k)) expect(km[k], k).not.toBe(en[k]);
  });

  it('PDF labels follow the language', () => {
    const en = renderDocumentPdf(docInput('en'));
    const km = renderDocumentPdf(docInput('km'));
    const both = renderDocumentPdf(docInput('both'));
    expect(pdfHas(en, 'INVOICE')).toBe(true);
    expect(pdfHas(en, 'Balance due')).toBe(true);
    expect(pdfHas(km, 'វិក្កយបត្រ')).toBe(true);
    expect(pdfHas(km, 'ទឹកប្រាក់ត្រូវបង់')).toBe(true);
    // Mixed lines are stored per script: the Khmer month with its copy text, the numbers as plain text.
    expect(pdfHas(km, 'វិច្ឆិកា')).toBe(true);
    expect(pdfHas(km, 'Balance due')).toBe(false);
    expect(pdfHas(both, 'វិក្កយបត្រ') && pdfHas(both, 'INVOICE')).toBe(true);
    expect(pdfHas(both, 'Balance due')).toBe(true);
  });

  it('the setting reaches the customer page, the email button, the chat widget and the call page', async () => {
    const { c } = await signup();
    const s = (await c.get('/settings/documents')).body;
    expect(s.customerLanguage).toBe('en');
    expect((await c.put('/settings/documents', { ...s, customerLanguage: 'fr' })).status).toBe(400);
    expect((await c.put('/settings/documents', { ...s, customerLanguage: 'km' })).status).toBe(200);

    const deal = (await c.post('/deals', { title: 'Arms' })).body;
    await c.put(`/deals/${deal.id}/line-items`, { items: [{ name: 'Robot arm', unitPrice: '100', quantity: 1, unit: 'pcs' }] });
    const inv = (await c.post(`/deals/${deal.id}/documents`, { kind: 'invoice' })).body;
    const sent = (await c.post(`/documents/${inv.id}/status`, { status: 'sent' })).body;
    const app = await getApp();
    const page = (await app.inject({ method: 'GET', url: `/api/v1/public/documents/${sent.customerUrl.split('/d/')[1]}` })).json();
    expect(page.lang).toBe('km');
    const pdf = (await c.download(`/documents/${inv.id}/pdf`)).body as Buffer;
    expect(pdfHas(pdf, 'វិក្កយបត្រ')).toBe(true);

    await c.post(`/documents/${inv.id}/email`, { to: ['ap@umbrella.test'], subject: 'Invoice', message: 'Hello' });
    const mail = (await pool.query(`SELECT payload FROM jobs WHERE type = 'email.send' ORDER BY id DESC LIMIT 1`)).rows[0].payload;
    expect(JSON.stringify(mail)).toContain('មើល និងបង់ប្រាក់តាមអនឡាញ');

    const ch = (await c.post('/channels', { kind: 'webchat', name: 'Chat' })).body;
    const w = (await app.inject({ method: 'GET', url: `/api/v1/public/webchat/${ch.publicKey}` })).json();
    expect(w).toMatchObject({ lang: 'km', texts: { chatSend: 'ផ្ញើ', chatMessage: 'សរសេរសារ…' } });
    expect(Object.keys(w.texts).every((k) => k.startsWith('chat'))).toBe(true); // only what the widget needs

    const call = (await c.post('/calls', {})).body;
    expect((await app.inject({ method: 'GET', url: `/api/v1/public/calls/${call.guestUrl.split('/join/')[1]}` })).json().lang).toBe('km');
  });
});
