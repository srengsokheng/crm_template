/** Lays out a quote or invoice on A4 pages with the tiny PDF writer. */
import qrcode from 'qrcode-generator';
import { A4, fitSize, PdfDoc, textWidth, winAnsi, wrapText } from './pdf.ts';

export interface PdfInput {
  kind: 'quote' | 'invoice';
  number: string | null;
  status: string;
  currency: string;
  issueDate: string | null;
  dueDate: string | null;
  billToName: string;
  billToDetails: string;
  notes: string;
  listTotal: string; discount: string; tax: string; total: string;
  /** Invoices: payments received so far (prints "Paid" and "Balance due" when > 0). */
  paidAmount?: string;
  items: { name: string; quantity: string | number; unit: string; unitPrice: string; discountType: string | null; discountValue: string | number | null; taxRate: string | number | null; taxIncluded: boolean; lineTotal: string }[];
  seller: { name: string; details: string; footer: string };
  /** Invoices: a KHQR (Bakong) payment QR for the balance due. */
  khqr?: { payload: string; expiresAt: string };
}

const GREY: [number, number, number] = [0.42, 0.44, 0.5];
const BRAND: [number, number, number] = [0.31, 0.27, 0.9];
const M = 48; // page margin
const RIGHT = A4.width - M;

/** Currency symbol when the PDF font can draw it ($, €, £, ¥), otherwise the ISO code (VND, INR, KRW…). */
export function formatMoney(v: string | number, currency: string): string {
  try {
    const withSymbol = new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(Number(v));
    if (!winAnsi(withSymbol).includes(63)) return withSymbol; // 63 = "?" = not encodable
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, currencyDisplay: 'code' }).format(Number(v)).replace(/\u00a0/g, ' ');
  } catch { return `${currency} ${Number(v).toFixed(2)}`; }
}
export function formatDate(d: string | null): string {
  if (!d) return '—';
  const [y, m, day] = d.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString('en-US', { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' });
}
const qty = (v: string | number) => String(Number(v));

export function renderDocumentPdf(d: PdfInput): Buffer {
  const title = d.kind === 'quote' ? 'Quote' : 'Invoice';
  const pdf = new PdfDoc(`${title} ${d.number ?? '(draft)'}`);
  const money = (v: string | number) => formatMoney(v, d.currency);

  // ── Header: seller on the left, document facts on the right ──
  let y = M;
  pdf.text(M, y, d.seller.name, { size: 16, bold: true });
  let ly = y + 22;
  for (const line of wrapText(d.seller.details, 9, 260)) { pdf.text(M, ly, line, { size: 9, color: GREY }); ly += 12; }

  pdf.text(RIGHT, y, title.toUpperCase(), { size: 20, bold: true, color: BRAND, align: 'right' });
  let ry = y + 28;
  const fact = (label: string, value: string) => {
    pdf.text(RIGHT - 110, ry, label, { size: 9, color: GREY, align: 'right' });
    pdf.text(RIGHT, ry, value, { size: 9, bold: true, align: 'right' });
    ry += 13;
  };
  fact('Number', d.number ?? 'Draft');
  fact('Date', formatDate(d.issueDate));
  fact(d.kind === 'quote' ? 'Valid until' : 'Due date', formatDate(d.dueDate));
  if (d.status !== 'sent') fact('Status', d.status.charAt(0).toUpperCase() + d.status.slice(1));
  y = Math.max(ly, ry) + 18;

  // ── Bill to ──
  pdf.text(M, y, d.kind === 'quote' ? 'PREPARED FOR' : 'BILL TO', { size: 8, bold: true, color: GREY });
  y += 13;
  if (d.billToName) { pdf.text(M, y, d.billToName, { size: 11, bold: true }); y += 15; }
  for (const line of wrapText(d.billToDetails, 9, 300)) { if (line) pdf.text(M, y, line, { size: 9, color: GREY }); y += 12; }
  y += 16;

  // ── Items table ──
  // Right edges of the numeric columns; the item column wraps within ITEM_W. Amounts shrink to fit their column.
  const col = { item: M + 8, qty: M + 250, price: M + 340, tax: M + 392, amount: RIGHT - 8 };
  const ITEM_W = 180;
  const W = { qty: 52, price: 84, tax: 46, amount: col.amount - col.tax - 10 };
  const header = () => {
    pdf.rect(M, y, RIGHT - M, 20, [0.95, 0.95, 0.98]);
    const o = { size: 8, bold: true, color: GREY };
    pdf.text(col.item, y + 6, 'ITEM', o);
    pdf.text(col.qty, y + 6, 'QTY', { ...o, align: 'right' });
    pdf.text(col.price, y + 6, 'UNIT PRICE', { ...o, align: 'right' });
    pdf.text(col.tax, y + 6, 'TAX', { ...o, align: 'right' });
    pdf.text(col.amount, y + 6, 'AMOUNT', { ...o, align: 'right' });
    y += 26;
  };
  const bottom = A4.height - M - 40;
  header();
  for (const it of d.items) {
    const nameLines = wrapText(it.name, 9.5, ITEM_W, true);
    const extra: string[] = [];
    if (it.discountType && Number(it.discountValue) > 0) extra.push(`Discount ${it.discountType === 'percent' ? `${Number(it.discountValue)}%` : money(it.discountValue ?? 0)}`);
    const h = nameLines.length * 12 + extra.length * 11 + 8;
    if (y + h > bottom) { pdf.addPage(); y = M; header(); }
    nameLines.forEach((l, i) => pdf.text(col.item, y + i * 12, l, { size: 9.5, bold: true }));
    extra.forEach((l, i) => pdf.text(col.item, y + nameLines.length * 12 + i * 11, l, { size: 8.5, color: GREY }));
    const q = `${qty(it.quantity)} ${it.unit}`;
    const price = money(it.unitPrice);
    const amount = money(it.lineTotal);
    pdf.text(col.qty, y, q, { size: fitSize(q, 9.5, W.qty), align: 'right' });
    pdf.text(col.price, y, price, { size: fitSize(price, 9.5, W.price), align: 'right' });
    pdf.text(col.tax, y, it.taxRate !== null && it.taxRate !== '' && Number(it.taxRate) > 0 ? `${Number(it.taxRate)}%${it.taxIncluded ? ' incl.' : ''}` : '—', { size: 9.5, align: 'right' });
    pdf.text(col.amount, y, amount, { size: fitSize(amount, 9.5, W.amount, true), bold: true, align: 'right' });
    y += h;
    pdf.line(M, y - 4, RIGHT, y - 4);
  }

  // ── Totals ──
  const rows: [string, string, boolean][] = [['Subtotal', money(d.listTotal), false]];
  if (Number(d.discount) > 0) rows.push(['Discount', `-${money(d.discount)}`, false]);
  rows.push(['Tax', money(d.tax), false], ['Total', money(d.total), true]);
  if (d.paidAmount && Number(d.paidAmount) > 0) {
    rows.push(['Paid', `-${money(d.paidAmount)}`, false], ['Balance due', money((Number(d.total) - Number(d.paidAmount)).toFixed(2)), true]);
  }
  if (y + rows.length * 18 + 10 > bottom) { pdf.addPage(); y = M; }
  y += 8;
  // Labels sit left of the widest value so long amounts never touch them.
  const labelX = Math.min(RIGHT - 110, RIGHT - Math.max(...rows.map(([, v, strong]) => textWidth(v, strong ? 11 : 9.5, strong))) - 16);
  for (const [label, value, strong] of rows) {
    if (strong) { pdf.line(Math.min(RIGHT - 200, labelX - 60), y - 4, RIGHT, y - 4, 1, [0.2, 0.2, 0.25]); y += 2; }
    pdf.text(labelX, y, label, { size: strong ? 11 : 9.5, bold: strong, color: strong ? undefined : GREY, align: 'right' });
    pdf.text(RIGHT, y, value, { size: strong ? 11 : 9.5, bold: strong, align: 'right' });
    y += strong ? 20 : 15;
  }

  // ── Notes ──
  if (d.notes.trim()) {
    const lines = wrapText(d.notes.trim(), 9, RIGHT - M);
    if (y + 30 + lines.length * 12 > bottom) { pdf.addPage(); y = M; }
    y += 14;
    pdf.text(M, y, 'NOTES', { size: 8, bold: true, color: GREY });
    y += 13;
    for (const l of lines) {
      if (y > bottom) { pdf.addPage(); y = M; }
      pdf.text(M, y, l, { size: 9 }); y += 12;
    }
  }

  // ── Pay with KHQR ──
  if (d.khqr) {
    const qr = qrcode(0, 'M');
    qr.addData(d.khqr.payload);
    qr.make();
    const n = qr.getModuleCount();
    const size = 116;
    const cell = size / n;
    if (y + size + 40 > bottom) { pdf.addPage(); y = M; }
    y += 18;
    pdf.text(M, y, 'PAY WITH KHQR', { size: 8, bold: true, color: GREY });
    y += 8;
    const top = y;
    // Dark modules as squares, run-length merged per row (smaller file, no hairline gaps in viewers).
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n;) {
        if (!qr.isDark(r, c)) { c++; continue; }
        let e = c;
        while (e < n && qr.isDark(r, e)) e++;
        pdf.rect(M + c * cell, top + r * cell, (e - c) * cell + 0.05, cell + 0.05, [0, 0, 0]);
        c = e;
      }
    }
    const tx = M + size + 16;
    const balance = d.paidAmount && Number(d.paidAmount) > 0 ? (Number(d.total) - Number(d.paidAmount)).toFixed(2) : d.total;
    pdf.text(tx, top + 14, money(balance), { size: 14, bold: true });
    pdf.text(tx, top + 32, 'Scan with any Bakong member bank app', { size: 9 });
    pdf.text(tx, top + 45, '(ABA, ACLEDA, Wing, Canadia, …) to pay this invoice.', { size: 9, color: GREY });
    pdf.text(tx, top + 64, `Valid until ${formatDate(d.khqr.expiresAt.slice(0, 10))}`, { size: 9, color: GREY });
    y = top + size + 8;
  }

  // ── Footer on every page ──
  const footer = wrapText(d.seller.footer, 8, RIGHT - M - 70).slice(0, 2);
  for (let p = 0; p < pdf.pageCount; p++) {
    pdf.goToPage(p);
    const fy = A4.height - M - 6;
    pdf.line(M, fy - 8, RIGHT, fy - 8);
    footer.forEach((l, i) => pdf.text(M, fy + i * 10, l, { size: 8, color: GREY }));
    pdf.text(RIGHT, fy, `Page ${p + 1} of ${pdf.pageCount}`, { size: 8, color: GREY, align: 'right' });
  }
  return pdf.toBuffer();
}
