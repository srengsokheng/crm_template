import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.ts';
import { pdfUnicodeString } from '../src/lib/pdfFonts.ts';
import { getApp, signup } from './helpers.ts';

afterAll(async () => { await (await getApp()).close(); await pool.end(); });

/** True when the PDF carries this text for copy & search. */
const pdfHas = (pdf: Buffer, text: string) => pdf.toString('latin1').includes(pdfUnicodeString(text).slice(5, -1)) || pdf.toString('latin1').includes(text);
const SIG = [[20, 70, 40, 30, 60, 75, 80, 35, 100, 70], [120, 60, 200, 55]];

async function sentQuote(c: any) {
  const deal = (await c.post('/deals', { title: 'Arms' })).body;
  await c.put(`/deals/${deal.id}/line-items`, { items: [{ name: 'Robot arm', unitPrice: '1000', quantity: 1, unit: 'pcs' }] });
  const q = (await c.post(`/deals/${deal.id}/documents`, { kind: 'quote' })).body;
  const sent = (await c.post(`/documents/${q.id}/status`, { status: 'sent' })).body;
  return { deal, q, token: sent.customerUrl.split('/d/')[1] as string };
}
const pub = async (method: 'GET' | 'POST', url: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await (await getApp()).inject({ method, url: `/api/v1/public/documents/${url}`, ...(body !== undefined ? { payload: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } } : {}) });
  return { status: r.statusCode, body: r.body && r.headers['content-type']?.toString().includes('json') ? JSON.parse(r.body) : r.rawPayload };
};

describe('signing a quote when accepting it', () => {
  it('optional by default: accepted without a signature, the PDF says who accepted online', async () => {
    const { c } = await signup();
    const { q, token } = await sentQuote(c);
    expect((await pub('GET', token)).body.requireSignature).toBe(false);
    expect((await pub('POST', `${token}/accept`, { name: 'Dara Sok' })).status).toBe(200);
    const doc = (await c.get(`/documents/${q.id}`)).body;
    expect(doc).toMatchObject({ status: 'accepted', respondedByName: 'Dara Sok', signature: null, signedIp: null });
    const pdf = (await c.download(`/documents/${q.id}/pdf`)).body as Buffer;
    expect(pdfHas(pdf, 'ACCEPTED')).toBe(true);
    expect(pdfHas(pdf, 'Accepted online by Dara Sok on')).toBe(true);
    expect(pdf.toString('latin1')).not.toContain(' 1 J 1 j ');
  });

  it('required by the workspace: no or bad signature refused; a drawn one is kept with IP and browser and printed', async () => {
    const { c } = await signup();
    const s = (await c.get('/settings/documents')).body;
    expect(s.requireSignature).toBe(false);
    await c.put('/settings/documents', { ...s, requireSignature: true });
    const { q, deal, token } = await sentQuote(c);
    expect((await pub('GET', token)).body.requireSignature).toBe(true);

    const none = await pub('POST', `${token}/accept`, { name: 'Dara Sok' });
    expect(none.status).toBe(400);
    expect(none.body.error.fields.signature).toBe('Please sign in the box.');
    expect((await pub('POST', `${token}/accept`, { name: 'Dara Sok', signature: [[10, 10, 12, 11]] })).status).toBe(400); // a dot
    expect((await pub('POST', `${token}/accept`, { name: 'Dara Sok', signature: [[10, 10, 400, 10]] })).status).toBe(400); // outside the box

    const ok = await pub('POST', `${token}/accept`, { name: 'Dara Sok', signature: SIG }, { 'user-agent': 'Mozilla/5.0 (Test phone)' });
    expect(ok.status).toBe(200);
    const doc = (await c.get(`/documents/${q.id}`)).body;
    expect(doc.signature).toEqual(SIG);
    expect(doc.signedIp).toBeTruthy();
    expect(doc.signedUserAgent).toBe('Mozilla/5.0 (Test phone)');
    // The customer's page shows it back.
    expect((await pub('GET', token)).body.response).toMatchObject({ by: 'Dara Sok', signature: SIG });
    // The PDF: heading, the drawn strokes (round-capped lines), and who signed.
    const pdf = (await c.download(`/documents/${q.id}/pdf`)).body as Buffer;
    expect(pdfHas(pdf, 'ACCEPTED AND SIGNED')).toBe(true);
    expect(pdfHas(pdf, 'Signed by Dara Sok on')).toBe(true);
    expect(pdf.toString('latin1').match(/ 1 J 1 j /g)?.length).toBe(2);
    // The deal's timeline records that it was signed.
    const ev = (await c.get(`/timeline/deal/${deal.id}`)).body.items.find((i: any) => i.type === 'event' && i.data.action === 'quote_accepted');
    expect(ev.data.changes).toMatchObject({ by: 'Dara Sok', signed: true });
    // Can't be accepted (or re-signed) twice.
    expect((await pub('POST', `${token}/accept`, { name: 'Someone', signature: SIG })).status).toBe(409);
  });

  it('Khmer PDF', async () => {
    const { c } = await signup();
    const s = (await c.get('/settings/documents')).body;
    await c.put('/settings/documents', { ...s, customerLanguage: 'km' });
    const { q, token } = await sentQuote(c);
    await pub('POST', `${token}/accept`, { name: 'សុខ ដារា', signature: SIG });
    const pdf = (await c.download(`/documents/${q.id}/pdf`)).body as Buffer;
    // Mixed lines are stored per script run (the space is its own run), so check the words.
    expect(pdfHas(pdf, 'បានទទួលយក') && pdfHas(pdf, 'និងចុះហត្ថលេខា')).toBe(true);
    expect(pdfHas(pdf, 'ចុះហត្ថលេខាដោយ')).toBe(true);
  });
});
