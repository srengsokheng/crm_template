import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { renderDocumentPdf, type PdfInput } from '../src/lib/documentPdf.ts';
import { PdfDoc, textRuns, textWidth, wrapText } from '../src/lib/pdf.ts';
import { pdfUnicodeString, shape } from '../src/lib/pdfFonts.ts';
import { pool } from '../src/db/pool.ts';
import { getApp, signup } from './helpers.ts';

afterAll(async () => { await (await getApp()).close(); await pool.end(); });

const FONT = readFileSync(new URL('../assets/fonts/NotoSansKhmer-Regular.ttf', import.meta.url));
const FONT_BOLD = readFileSync(new URL('../assets/fonts/NotoSansKhmer-Bold.ttf', import.meta.url));

/** Cross-reference offsets point at their objects; every stream's /Length is exact. Returns the file as latin1. */
function assertValidPdf(buf: Buffer) {
  const s = buf.toString('latin1');
  expect(s.startsWith('%PDF-1.4')).toBe(true);
  const start = Number(/startxref\n(\d+)/.exec(s)![1]);
  expect(s.slice(start, start + 4)).toBe('xref');
  const offsets = [...s.slice(start).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  offsets.forEach((o, i) => expect(s.slice(o, o + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
  for (const m of s.matchAll(/<< \/Length (\d+)[^\n]*>>\nstream\n/g)) {
    const at = m.index! + m[0].length;
    expect(s.slice(at + Number(m[1]), at + Number(m[1]) + 10)).toBe('\nendstream');
  }
  return s;
}
/** The embedded font files, decompressed. */
function embeddedFonts(s: string): Buffer[] {
  return [...s.matchAll(/<< \/Length (\d+) \/Length1 (\d+) \/Filter \/FlateDecode >>\nstream\n/g)].map((m) => {
    const at = m.index! + m[0].length;
    const out = inflateSync(Buffer.from(s.slice(at, at + Number(m[1])), 'latin1'));
    expect(out.length).toBe(Number(m[2]));
    return out;
  });
}

const base: PdfInput = {
  kind: 'invoice', number: 'INV-1', status: 'sent', currency: 'USD', issueDate: '2026-11-17', dueDate: null, billToName: 'Globex',
  billToDetails: '', notes: '', listTotal: '10', discount: '0', tax: '0', total: '10', items: [], seller: { name: 'Acme', details: '', footer: '' },
};

describe('Unicode (Khmer) text in PDFs', () => {
  it('splits text into Helvetica and Khmer runs; other scripts still print as "?"', () => {
    expect(textRuns('Ada ក្រុមហ៊ុន, 12')).toEqual([{ font: 'latin', text: 'Ada ' }, { font: 'unicode', text: 'ក្រុមហ៊ុន' }, { font: 'latin', text: ', 12' }]);
    expect(textRuns('ក​ខ')).toEqual([{ font: 'unicode', text: 'ក​ខ' }]); // Khmer word separator: drawn (invisibly) by the font
    expect(textRuns('a⁠b')).toEqual([{ font: 'latin', text: 'ab' }]); // other invisible joiners are dropped, not "?"
    expect(textRuns('東京')).toEqual([{ font: 'latin', text: '東京' }]); // no font for Chinese → "?" via WinAnsi
    const pdf = new PdfDoc();
    pdf.text(10, 10, '東京');
    expect(pdf.toBuffer().toString('latin1')).toContain('(??)');
  });

  it('shapes Khmer: subscripts and vowel signs become positioned glyphs, and every character is accounted for', () => {
    const s = shape('ខ្មែរ', false);
    // ែ is written before the consonant cluster: HarfBuzz reorders it to the first glyph.
    expect(s.glyphs.map((g) => g.text).join('')).toHaveLength('ខ្មែរ'.length);
    expect(s.glyphs[0].text).toBe('ែ');
    expect(s.glyphs.some((g) => g.text === '្ម')).toBe(true); // coeng + mo → one subscript glyph
    expect(s.advance).toBeGreaterThan(0);
    expect(textWidth('ខ្មែរ', 10)).toBeCloseTo((s.advance * 10) / 1000, 5);
    expect(textWidth('ខ្មែរ', 10, true)).toBeGreaterThan(0);
  });

  it('measures accented letters and punctuation with their real widths', () => {
    expect(textWidth('—', 10)).toBeCloseTo(10, 5); // em dash is 1000/1000 em (was guessed as 556)
    expect(textWidth('é', 10)).toBeCloseTo(textWidth('e', 10), 5);
    expect(textWidth('“', 10, true)).toBeCloseTo(5, 5);
  });

  it('wraps Khmer (written without spaces) at word boundaries', () => {
    const text = 'ការថែទាំប្រព័ន្ធប្រចាំខែសម្រាប់ក្រុមហ៊ុនធំៗទាំងអស់នៅក្នុងប្រទេសកម្ពុជា';
    const lines = wrapText(text, 9.5, 120, true);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join('')).toBe(text);
    for (const l of lines) expect(textWidth(l, 9.5, true)).toBeLessThanOrEqual(120);
    const words = [...new Intl.Segmenter('km', { granularity: 'word' }).segment(text)].map((w) => w.index);
    for (let i = 1, at = lines[0].length; i < lines.length; at += lines[i].length, i++) expect(words).toContain(at);
  });

  it('embeds the font only when Khmer is used: valid file, ActualText for copy/search, title in UTF-16', () => {
    const latin = assertValidPdf(renderDocumentPdf(base));
    expect(latin).not.toContain('FontFile2');
    expect(latin.length).toBeLessThan(5000);

    const pdf = renderDocumentPdf({
      ...base, billToName: 'ក្រុមហ៊ុន អង្គរ', notes: 'សូមអរគុណ',
      items: [{ name: 'សេវាកម្ម', quantity: 1, unit: 'h', unitPrice: '10', discountType: null, discountValue: null, taxRate: null, taxIncluded: false, lineTotal: '10' }],
    });
    const s = assertValidPdf(pdf);
    expect(s).toContain('/BaseFont /NotoSansKhmer-Regular /Encoding /Identity-H');
    expect(s).toContain('/BaseFont /NotoSansKhmer-Bold /Encoding /Identity-H'); // bill-to name and item names are bold
    const fonts = embeddedFonts(s);
    expect(fonts).toHaveLength(2);
    expect(fonts.some((f) => f.equals(FONT))).toBe(true);
    expect(fonts.some((f) => f.equals(FONT_BOLD))).toBe(true);
    expect(s).toContain(`/ActualText ${pdfUnicodeString('ក្រុមហ៊ុន')}`);
    expect(s).toContain(`/ActualText ${pdfUnicodeString('សូមអរគុណ')}`);
    expect(s).toContain('/ToUnicode');
    expect(s).not.toMatch(/\(\?+\)/); // nothing fell back to "?"
    expect(pdf.length).toBeLessThan(200_000);

    const titled = new PdfDoc('វិក្កយបត្រ 1');
    expect(titled.toBuffer().toString('latin1')).toContain(`/Title ${pdfUnicodeString('វិក្កយបត្រ 1')}`);
  });

  it('API: an invoice for a Khmer-named company downloads as a PDF with the Khmer font', async () => {
    const { c } = await signup();
    await c.put('/settings/documents', { companyDetails: 'ហាង Acme\nភ្នំពេញ', footer: 'អរគុណ!', quotePrefix: 'Q-', invoicePrefix: 'INV-', quoteValidDays: 15, paymentTermsDays: 7 });
    const co = (await c.post('/companies', { name: 'ក្រុមហ៊ុន អង្គរ ឌីជីថល' })).body;
    const deal = (await c.post('/deals', { title: 'Website', companyId: co.id })).body;
    expect((await c.put(`/deals/${deal.id}/line-items`, { items: [{ name: 'ការរចនាគេហទំព័រ', unitPrice: '1000', quantity: 1, unit: 'pc' }] })).status).toBe(200);
    const inv = (await c.post(`/deals/${deal.id}/documents`, { kind: 'invoice' })).body;
    const res = await c.download(`/documents/${inv.id}/pdf`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    const s = assertValidPdf(res.body);
    expect(s).toContain(`/ActualText ${pdfUnicodeString('ក្រុមហ៊ុន')}`);
    expect(s).toContain(`/ActualText ${pdfUnicodeString('ការរចនាគេហទំព័រ')}`);
    expect(s).toContain(`/ActualText ${pdfUnicodeString('អរគុណ')}`);
    expect(embeddedFonts(s)).toHaveLength(2);

    // Another workspace still can't download it (unchanged rule, checked here because the file now carries more data).
    const other = await signup();
    expect((await other.c.download(`/documents/${inv.id}/pdf`)).status).toBe(404);
  });
});
