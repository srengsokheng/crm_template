import { afterAll, describe, expect, it } from 'vitest';
import { formatMoney, renderDocumentPdf } from '../src/lib/documentPdf.ts';
import { fitSize, PdfDoc, textWidth, winAnsi, wrapText } from '../src/lib/pdf.ts';
import { pool } from '../src/db/pool.ts';
import { getApp, inviteUser, signup } from './helpers.ts';

afterAll(async () => { await (await getApp()).close(); await pool.end(); });

/** Checks the cross-reference table: every offset must point at "<n> 0 obj". */
function assertValidPdf(buf: Buffer) {
  const s = buf.toString('latin1');
  expect(s.startsWith('%PDF-1.4')).toBe(true);
  expect(s.trimEnd().endsWith('%%EOF')).toBe(true);
  const start = Number(/startxref\n(\d+)/.exec(s)![1]);
  expect(s.slice(start, start + 4)).toBe('xref');
  const offsets = [...s.slice(start).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  offsets.forEach((o, i) => expect(s.slice(o, o + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
  for (const m of s.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
    const at = m.index! + m[0].length;
    expect(s.slice(at + Number(m[1]), at + Number(m[1]) + 10)).toBe('\nendstream');
  }
  return s;
}

const items = [
  { name: 'Robot arm', unitPrice: '1000', quantity: 2, unit: 'pcs', discountType: 'percent', discountValue: 10, taxRate: 10 },
  { name: 'Installation', unitPrice: '250.50', quantity: 1, unit: 'h' },
];

describe('quotes and invoices', () => {
  it('quote: draft from deal products, edit, send (numbered), accept, then invoice → sent → paid', async () => {
    const { c } = await signup();
    await c.put('/settings/documents', { companyDetails: 'Acme Robotics Ltd\n1 Main St, Phnom Penh', footer: 'Thank you!', quotePrefix: 'Q-', invoicePrefix: 'INV-', quoteValidDays: 15, paymentTermsDays: 7 });
    const co = (await c.post('/companies', { name: 'Globex', address: { street: '5 Side Rd', city: 'Springfield', country: 'USA' }, methods: [{ kind: 'email', value: 'ap@globex.test' }] })).body;
    const deal = (await c.post('/deals', { title: 'Arms', companyId: co.id })).body;
    expect((await c.put(`/deals/${deal.id}/line-items`, { items })).status).toBe(200);

    const q = await c.post(`/deals/${deal.id}/documents`, { kind: 'quote' });
    expect(q.status, JSON.stringify(q.body)).toBe(201);
    expect(q.body).toMatchObject({ kind: 'quote', status: 'draft', number: null, billToName: 'Globex', listTotal: '2250.50', discount: '200.00', tax: '180.00', total: '2230.50' });
    expect(q.body.billToDetails).toContain('5 Side Rd');
    expect(q.body.billToDetails).toContain('ap@globex.test');
    expect(q.body.items.map((i: any) => i.name)).toEqual(['Robot arm', 'Installation']);

    // Edit the draft: the server recomputes totals.
    const edited = await c.patch(`/documents/${q.body.id}`, { notes: 'Delivery in 2 weeks', items: [items[1]] });
    expect(edited.body).toMatchObject({ notes: 'Delivery in 2 weeks', total: '250.50' });
    await c.patch(`/documents/${q.body.id}`, { items });

    const sent = (await c.post(`/documents/${q.body.id}/status`, { status: 'sent' })).body;
    expect(sent).toMatchObject({ status: 'sent', number: 'Q-0001' });
    const days = (Date.parse(sent.dueDate) - Date.parse(sent.issueDate)) / 86400000;
    expect(days).toBe(15);
    expect((await c.patch(`/documents/${q.body.id}`, { notes: 'x' })).status).toBe(409); // locked once sent
    expect((await c.del(`/documents/${q.body.id}`)).status).toBe(409);
    // An invoice can't be made from a quote that isn't accepted.
    expect((await c.post(`/deals/${deal.id}/documents`, { kind: 'invoice', fromQuoteId: q.body.id })).status).toBe(409);
    expect((await c.post(`/documents/${q.body.id}/status`, { status: 'paid' })).status).toBe(409);
    await c.post(`/documents/${q.body.id}/status`, { status: 'accepted' });

    const inv = (await c.post(`/deals/${deal.id}/documents`, { kind: 'invoice', fromQuoteId: q.body.id })).body;
    expect(inv).toMatchObject({ kind: 'invoice', status: 'draft', total: '2230.50', sourceQuoteId: q.body.id, notes: 'Delivery in 2 weeks' });
    const invSent = (await c.post(`/documents/${inv.id}/status`, { status: 'sent' })).body;
    expect(invSent.number).toBe('INV-0001');
    expect((Date.parse(invSent.dueDate) - Date.parse(invSent.issueDate)) / 86400000).toBe(7);
    expect((await c.post(`/documents/${inv.id}/status`, { status: 'paid' })).body.status).toBe('paid');
    expect((await c.post(`/documents/${inv.id}/status`, { status: 'void' })).status).toBe(409);

    const list = (await c.get(`/deals/${deal.id}/documents`)).body.data;
    expect(list.map((d: any) => `${d.kind}:${d.number}:${d.status}`)).toEqual(['invoice:INV-0001:paid', 'quote:Q-0001:accepted']);
    const hist = (await c.get(`/history/deal/${deal.id}`)).body.data.map((h: any) => h.action);
    expect(hist).toEqual(expect.arrayContaining(['document_created', 'quote_sent', 'quote_accepted', 'invoice_sent', 'invoice_paid']));

    // PDF
    const pdf = await c.download(`/documents/${inv.id}/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toBe('attachment; filename="INV-0001.pdf"');
    const text = assertValidPdf(pdf.body);
    for (const s of ['(INVOICE)', '(INV-0001)', '(Globex)', '(Robot arm)', '($2,230.50)', '(Thank you!)', '(Acme Robotics Ltd)', '(Page 1 of 1)']) expect(text).toContain(s);
  });

  it('numbers only sent documents, without gaps, per workspace', async () => {
    const { c } = await signup();
    const deal = (await c.post('/deals', { title: 'N' })).body;
    await c.put(`/deals/${deal.id}/line-items`, { items: [items[1]] });
    const a = (await c.post(`/deals/${deal.id}/documents`, { kind: 'invoice' })).body;
    const b = (await c.post(`/deals/${deal.id}/documents`, { kind: 'invoice' })).body;
    const empty = (await c.post(`/deals/${deal.id}/documents`, { kind: 'quote' })).body;
    await c.patch(`/documents/${empty.id}`, { items: [] });
    expect((await c.post(`/documents/${empty.id}/status`, { status: 'sent' })).status).toBe(400); // no items
    expect((await c.del(`/documents/${a.id}`)).status).toBe(204); // drafts can be deleted, no number used
    expect((await c.post(`/documents/${b.id}/status`, { status: 'sent' })).body.number).toBe('INV-0001');
    expect((await c.post(`/documents/${b.id}/status`, { status: 'void' })).body.status).toBe('void');
    const other = await signup('Other');
    const d2 = (await other.c.post('/deals', { title: 'M' })).body;
    await other.c.put(`/deals/${d2.id}/line-items`, { items: [items[1]] });
    const x = (await other.c.post(`/deals/${d2.id}/documents`, { kind: 'invoice' })).body;
    expect((await other.c.post(`/documents/${x.id}/status`, { status: 'sent' })).body.number).toBe('INV-0001');
    // Workspace isolation
    for (const [m, u] of [['get', `/documents/${b.id}`], ['get', `/documents/${b.id}/pdf`], ['del', `/documents/${b.id}`], ['get', `/deals/${deal.id}/documents`]] as const)
      expect((await (other.c as any)[m](u)).status).toBe(404);
    expect((await other.c.post(`/deals/${d2.id}/documents`, { kind: 'invoice', fromQuoteId: b.id })).status).toBe(404);
  });

  it('follows the deal’s permissions and settings are admin-only', async () => {
    const { c } = await signup();
    const viewer = await inviteUser(c, 'Viewer');
    const deal = (await c.post('/deals', { title: 'P' })).body;
    const doc = (await c.post(`/deals/${deal.id}/documents`, { kind: 'quote' })).body;
    expect((await viewer.c.get(`/documents/${doc.id}`)).status).toBe(200);
    expect((await viewer.c.download(`/documents/${doc.id}/pdf`)).status).toBe(200);
    expect((await viewer.c.post(`/deals/${deal.id}/documents`, { kind: 'quote' })).status).toBe(403);
    expect((await viewer.c.patch(`/documents/${doc.id}`, { notes: 'x' })).status).toBe(403);
    expect((await viewer.c.post(`/documents/${doc.id}/status`, { status: 'sent' })).status).toBe(403);
    expect((await viewer.c.del(`/documents/${doc.id}`)).status).toBe(403);
    expect((await viewer.c.get('/settings/documents')).status).toBe(403);
    expect((await viewer.c.put('/settings/documents', {})).status).toBe(403);
    // A restricted pipeline hides the documents as well.
    const roles = (await c.get('/roles')).body.data;
    await c.patch(`/pipelines/${deal.pipelineId}`, { allowedRoleIds: [roles.find((r: any) => r.name === 'Manager').id] });
    expect((await viewer.c.get(`/documents/${doc.id}`)).status).toBe(403);
    // Deleted deal → its documents are gone too.
    await c.patch(`/pipelines/${deal.pipelineId}`, { allowedRoleIds: null });
    await c.del(`/deals/${deal.id}`);
    expect((await c.get(`/documents/${doc.id}`)).status).toBe(404);
    expect((await c.put('/settings/documents', { quoteValidDays: 0 })).status).toBe(400);
  });
});

describe('pdf writer', () => {
  it('encodes text, measures, wraps and builds a valid multi-page file', () => {
    expect(winAnsi('A€é“x”–')).toEqual([65, 0x80, 0xe9, 0x93, 120, 0x94, 0x96]);
    expect(winAnsi('ខ')).toEqual([63]); // outside WinAnsi
    expect(winAnsi('−')).toEqual([45]); // minus sign prints as a hyphen, not "?"
    expect(formatMoney('1234.5', 'USD')).toBe('$1,234.50');
    expect(formatMoney('1234.5', 'EUR')).toBe('€1,234.50');
    expect(formatMoney('11820000', 'VND')).toBe('VND 11,820,000'); // ₫ can't be drawn by the built-in font
    expect(fitSize('KHR 10,364.00', 9.5, 200, true)).toBe(9.5);
    expect(textWidth('VND 11,820,000,000,000', fitSize('VND 11,820,000,000,000', 9.5, 70, true), true)).toBeLessThanOrEqual(70);
    expect(textWidth('Hello', 10)).toBeCloseTo(22.78, 1);
    expect(wrapText('one two three four', 10, 40)).toEqual(['one two', 'three', 'four']);
    expect(wrapText('Supercalifragilistic', 10, 40).every((l) => textWidth(l, 10) <= 40)).toBe(true);
    const pdf = new PdfDoc('Test (1)');
    pdf.text(10, 10, 'a (b) \\ c');
    pdf.addPage();
    pdf.text(10, 10, 'page two');
    const s = assertValidPdf(pdf.toBuffer());
    expect(s).toContain('(a \\(b\\) \\\\ c)');
    expect(s).toContain('/Count 2');
  });

  it('starts new pages for long documents with a header and page numbers', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ name: `Item ${i + 1} with a fairly long description that wraps onto a second line in the table`, quantity: 1, unit: 'pcs', unitPrice: '10.00', discountType: null, discountValue: null, taxRate: null, taxIncluded: false, lineTotal: '10.00' }));
    const s = assertValidPdf(renderDocumentPdf({ kind: 'quote', number: null, status: 'draft', currency: 'EUR', issueDate: null, dueDate: null, billToName: 'X', billToDetails: '', notes: 'n', listTotal: '600', discount: '0', tax: '0', total: '600', items: many, seller: { name: 'S', details: '', footer: '' } }));
    const pages = Number(/\/Count (\d+)/.exec(s)![1]);
    expect(pages).toBeGreaterThan(1);
    expect(s).toContain(`(Page ${pages} of ${pages})`);
    expect(s.match(/\(ITEM\)/g)!.length).toBe(pages);
    expect(s).toContain('(\\200600.00)'); // € is WinAnsi 0x80 = octal 200
    expect(s).toContain('(Draft)');
  });
});
