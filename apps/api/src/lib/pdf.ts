/**
 * A tiny PDF writer (no dependency): A4 pages, text in the built-in Helvetica / Helvetica-Bold fonts, lines and filled
 * rectangles. Enough for quotes and invoices. Coordinates are in points from the TOP-left corner.
 *
 * Text is encoded as WinAnsi (Latin-1 plus €, curly quotes, dashes, bullet, ellipsis). Characters outside that set
 * (e.g. Khmer, Chinese) print as "?" — embedding a Unicode font would need a font file and a font parser.
 */

export const A4 = { width: 595.28, height: 841.89 };
type Rgb = [number, number, number];
export interface TextOpts { size?: number; bold?: boolean; color?: Rgb; align?: 'left' | 'right' | 'center' }

// Advance widths (1/1000 em) for ASCII 32..126 from the standard Helvetica AFM files.
const HELV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
  278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722,
  667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556,
  333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const HELV_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
  333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722,
  667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611,
  389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];

// Unicode → WinAnsi for the few characters outside Latin-1 that invoices commonly use.
const WIN: Record<number, number> = { 0x20ac: 0x80, 0x2026: 0x85, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x2122: 0x99, 0x2212: 0x2d /* minus sign → hyphen */ };

/** Unicode string → WinAnsi byte codes (unknown characters become "?"). */
export function winAnsi(s: string): number[] {
  const out: number[] = [];
  for (const ch of s.normalize('NFC')) {
    const c = ch.codePointAt(0)!;
    if (c === 0x09) out.push(32);
    else if ((c >= 32 && c <= 126) || (c >= 0xa0 && c <= 0xff)) out.push(c);
    else if (WIN[c]) out.push(WIN[c]);
    else if (c === 0x202f) out.push(32); // narrow no-break space (Intl number formats)
    else out.push(63);
  }
  return out;
}

/** Largest font size ≤ size (down to 6pt) at which the text fits the width. */
export function fitSize(s: string, size: number, maxWidth: number, bold = false): number {
  let fs = size;
  while (fs > 6 && textWidth(s, fs, bold) > maxWidth) fs -= 0.5;
  return fs;
}

export function textWidth(s: string, size: number, bold = false): number {
  const table = bold ? HELV_BOLD : HELV;
  let w = 0;
  for (const b of winAnsi(s)) w += b >= 32 && b <= 126 ? table[b - 32] : 556;
  return (w * size) / 1000;
}

/** Splits text into lines no wider than maxWidth (breaks long words too). Keeps explicit newlines. */
export function wrapText(s: string, size: number, maxWidth: number, bold = false): string[] {
  const lines: string[] = [];
  for (const para of s.split(/\r?\n/)) {
    let line = '';
    for (const word of para.split(/ +/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (textWidth(candidate, size, bold) <= maxWidth) { line = candidate; continue; }
      if (line) lines.push(line);
      line = word;
      while (textWidth(line, size, bold) > maxWidth && line.length > 1) { // a single word wider than the column
        let cut = line.length - 1;
        while (cut > 1 && textWidth(line.slice(0, cut), size, bold) > maxWidth) cut--;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    lines.push(line);
  }
  return lines;
}

const num = (n: number) => (Math.round(n * 100) / 100).toString();
const pdfString = (s: string) => '(' + winAnsi(s).map((b) => (b === 0x28 || b === 0x29 || b === 0x5c ? '\\' + String.fromCharCode(b) : b > 126 ? '\\' + b.toString(8).padStart(3, '0') : String.fromCharCode(b))).join('') + ')';

export class PdfDoc {
  private pages: string[][] = [];
  private title: string;
  constructor(title = 'Document') { this.title = title; this.addPage(); }

  private cur = 0;
  get pageCount() { return this.pages.length; }
  addPage() { this.pages.push([]); this.cur = this.pages.length - 1; }
  /** Draw on another page (e.g. "Page 1 of 3" footers once the page count is known). */
  goToPage(index: number) { this.cur = index; }
  private get ops() { return this.pages[this.cur]; }

  text(x: number, y: number, s: string, o: TextOpts = {}) {
    const size = o.size ?? 10;
    const w = o.align && o.align !== 'left' ? textWidth(s, size, o.bold) : 0;
    const left = o.align === 'right' ? x - w : o.align === 'center' ? x - w / 2 : x;
    const [r, g, b] = o.color ?? [0.1, 0.1, 0.12];
    this.ops.push(`BT ${num(r)} ${num(g)} ${num(b)} rg /${o.bold ? 'F2' : 'F1'} ${size} Tf ${num(left)} ${num(A4.height - y - size * 0.8)} Td ${pdfString(s)} Tj ET`);
  }
  line(x1: number, y1: number, x2: number, y2: number, width = 0.5, color: Rgb = [0.85, 0.85, 0.88]) {
    this.ops.push(`${num(width)} w ${color.map(num).join(' ')} RG ${num(x1)} ${num(A4.height - y1)} m ${num(x2)} ${num(A4.height - y2)} l S`);
  }
  rect(x: number, y: number, w: number, h: number, fill: Rgb) {
    this.ops.push(`${fill.map(num).join(' ')} rg ${num(x)} ${num(A4.height - y - h)} ${num(w)} ${num(h)} re f`);
  }

  toBuffer(): Buffer {
    const objects: string[] = [];
    const add = (body: string) => { objects.push(body); return objects.length; };
    add('<< /Type /Catalog /Pages 2 0 R >>');
    add(''); // pages, filled below
    const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const info = add(`<< /Title ${pdfString(this.title)} /Producer (Acme CRM) >>`);
    const kids: number[] = [];
    for (const ops of this.pages) {
      const content = ops.join('\n');
      const c = add(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
      kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4.width} ${A4.height}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${c} 0 R >>`));
    }
    objects[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
    let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
    const offsets: number[] = [];
    objects.forEach((body, i) => { offsets.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
    const xref = Buffer.byteLength(out, 'latin1');
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
    out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
  }
}
