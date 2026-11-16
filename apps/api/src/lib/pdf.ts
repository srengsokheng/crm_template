/**
 * A tiny PDF writer (no dependency): A4 pages, text in the built-in Helvetica / Helvetica-Bold fonts, lines and filled
 * rectangles. Enough for quotes and invoices. Coordinates are in points from the TOP-left corner.
 *
 * Text is encoded as WinAnsi (Latin-1 plus €, curly quotes, dashes, bullet, ellipsis). Runs of other characters that
 * the embedded Unicode font covers (Khmer — see pdfFonts.ts) are shaped and drawn with that font; anything else (e.g.
 * Chinese, Thai) still prints as "?".
 */
import { canDraw, fontObjects, glyphAdvance, pdfUnicodeString, shape, unicodeFont } from './pdfFonts.ts';

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

// Widths of WinAnsi characters above ASCII that aren't accented letters ([regular, bold]); accented letters use the
// width of their base letter (é → e).
const HIGH: Record<number, [number, number]> = {
  0x80: [556, 556], 0x85: [1000, 1000], 0x91: [222, 278], 0x92: [222, 278], 0x93: [333, 500], 0x94: [333, 500], 0x95: [350, 350],
  0x96: [556, 556], 0x97: [1000, 1000], 0x99: [1000, 1000], 0xa0: [278, 278], 0xa1: [333, 333], 0xa9: [737, 737], 0xab: [556, 556],
  0xae: [737, 737], 0xb0: [400, 400], 0xb1: [584, 584], 0xb5: [556, 611], 0xb7: [278, 278], 0xbb: [556, 556], 0xbf: [611, 611],
  0xc6: [1000, 1000], 0xd7: [584, 584], 0xd8: [778, 778], 0xdf: [611, 611], 0xe6: [889, 889], 0xf7: [584, 584], 0xf8: [611, 611],
};

// Unicode → WinAnsi for the few characters outside Latin-1 that invoices commonly use.
const WIN: Record<number, number> = { 0x20ac: 0x80, 0x2026: 0x85, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x2122: 0x99, 0x2212: 0x2d /* minus sign → hyphen */ };

/** WinAnsi byte for one code point, or undefined when Helvetica can't draw it. */
function winAnsiCode(c: number): number | undefined {
  if (c === 0x09 || c === 0x202f) return 32; // tab, narrow no-break space (Intl number formats)
  if ((c >= 32 && c <= 126) || (c >= 0xa0 && c <= 0xff)) return c;
  return WIN[c];
}
const ZERO_WIDTH = new Set([0x200b, 0x200c, 0x200d, 0x2060, 0xfeff]);

/** Unicode string → WinAnsi byte codes (unknown characters become "?"). */
export function winAnsi(s: string): number[] {
  const out: number[] = [];
  for (const ch of s.normalize('NFC')) out.push(winAnsiCode(ch.codePointAt(0)!) ?? 63);
  return out;
}

type Run = { font: 'latin' | 'unicode'; text: string };
/** Splits text into runs for Helvetica ('latin') and for the embedded Unicode font ('unicode'). */
export function textRuns(s: string): Run[] {
  const runs: Run[] = [];
  for (const ch of s.normalize('NFC')) {
    const c = ch.codePointAt(0)!;
    const font = winAnsiCode(c) !== undefined ? 'latin' : canDraw(c) ? 'unicode' : ZERO_WIDTH.has(c) ? null : 'latin';
    if (!font) continue; // invisible joiners / word separators the fonts don't need
    const last = runs[runs.length - 1];
    if (last && last.font === font) last.text += ch; else runs.push({ font, text: ch });
  }
  return runs;
}

/** Largest font size ≤ size (down to 6pt) at which the text fits the width. */
export function fitSize(s: string, size: number, maxWidth: number, bold = false): number {
  let fs = size;
  while (fs > 6 && textWidth(s, fs, bold) > maxWidth) fs -= 0.5;
  return fs;
}

export function textWidth(s: string, size: number, bold = false): number {
  let w = 0;
  for (const run of textRuns(s)) w += run.font === 'latin' ? latinWidth(run.text, size, bold) : (shape(run.text, bold).advance * size) / unicodeFont(bold).upem;
  return w;
}
function latinWidth(s: string, size: number, bold: boolean): number {
  const table = bold ? HELV_BOLD : HELV;
  const ascii = (b: number) => (b >= 32 && b <= 126 ? table[b - 32] : undefined);
  let w = 0;
  for (const ch of s.normalize('NFC')) {
    const b = winAnsiCode(ch.codePointAt(0)!) ?? 63;
    w += ascii(b) ?? HIGH[b]?.[bold ? 1 : 0] ?? ascii(ch.normalize('NFD').charCodeAt(0)) ?? 556;
  }
  return (w * size) / 1000;
}

const words = new Intl.Segmenter('km', { granularity: 'word' });
const graphemes = new Intl.Segmenter('km', { granularity: 'grapheme' });
/** Offsets where s may be broken by the segmenter (excluding the end). */
const boundaries = (seg: Intl.Segmenter, s: string) => [...seg.segment(s)].map((x) => x.index + x.segment.length).filter((i) => i < s.length);

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
      while (textWidth(line, size, bold) > maxWidth) { // a single word wider than the column
        // Prefer the longest piece ending at a word boundary (Khmer writes words without spaces), else between characters.
        const fits = (i: number) => textWidth(line.slice(0, i), size, bold) <= maxWidth;
        const chars = boundaries(graphemes, line);
        const cut = boundaries(words, line).reverse().find(fits) ?? [...chars].reverse().find(fits) ?? chars[0];
        if (cut === undefined) break; // a single character wider than the column: let it overflow
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    lines.push(line);
  }
  return lines;
}

const num = (n: number) => (Math.round(n * 100) / 100).toString();
const latinString = (s: string) => '(' + winAnsi(s).map((b) => (b === 0x28 || b === 0x29 || b === 0x5c ? '\\' + String.fromCharCode(b) : b > 126 ? '\\' + b.toString(8).padStart(3, '0') : String.fromCharCode(b))).join('') + ')';

export class PdfDoc {
  private pages: string[][] = [];
  private title: string;
  constructor(title = 'Document') { this.title = title; this.addPage(); }
  /** Glyphs drawn with the embedded Unicode fonts (glyph id → text), so only fonts actually used are embedded. */
  private used = { regular: new Map<number, string>(), bold: new Map<number, string>() };

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
    const color = `${num(r)} ${num(g)} ${num(b)} rg`;
    const baseline = A4.height - y - size * 0.8;
    let x0 = left;
    for (const run of textRuns(s)) {
      if (run.font === 'latin') {
        this.ops.push(`BT ${color} /${o.bold ? 'F2' : 'F1'} ${size} Tf ${num(x0)} ${num(baseline)} Td ${latinString(run.text)} Tj ET`);
        x0 += latinWidth(run.text, size, !!o.bold);
        continue;
      }
      // Shaped glyphs placed where HarfBuzz put them: horizontal offsets as TJ adjustments (the viewer advances by each
      // glyph's /W width, we correct to HarfBuzz's pen position), vertical offsets (stacked marks) as text rise.
      const f = unicodeFont(o.bold);
      const used = o.bold ? this.used.bold : this.used.regular;
      const shaped = shape(run.text, o.bold);
      const ops: string[] = [];
      let tj: string[] = [];
      let rise = 0;
      let pen = 0; // HarfBuzz pen position, font units
      let cur = 0; // where the viewer's text position is, font units
      const flush = () => { if (tj.length) ops.push(`[${tj.join(' ')}] TJ`); tj = []; };
      for (const gl of shaped.glyphs) {
        if (!used.get(gl.gid)) used.set(gl.gid, gl.text);
        if (gl.dy !== rise) { flush(); rise = gl.dy; ops.push(`${num(rise * size / f.upem)} Ts`); }
        const target = pen + gl.dx;
        if (target !== cur) tj.push(num(((cur - target) * 1000) / f.upem));
        tj.push(`<${gl.gid.toString(16).padStart(4, '0')}>`);
        cur = target + glyphAdvance(f, gl.gid);
        pen += gl.ax;
      }
      flush();
      if (rise) ops.push('0 Ts');
      // ActualText gives copy & search the original characters in their logical order.
      this.ops.push(`/Span << /ActualText ${pdfUnicodeString(run.text)} >> BDC BT ${color} /${o.bold ? 'F4' : 'F3'} ${size} Tf ${num(x0)} ${num(baseline)} Td ${ops.join(' ')} ET EMC`);
      x0 += (shaped.advance * size) / f.upem;
    }
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
    const title = winAnsi(this.title).includes(63) ? pdfUnicodeString(this.title) : latinString(this.title);
    const info = add(`<< /Title ${title} /Producer (Acme CRM) >>`);
    let fonts = `/F1 ${f1} 0 R /F2 ${f2} 0 R`;
    if (this.used.regular.size) fonts += ` /F3 ${fontObjects(unicodeFont(false), this.used.regular, add)} 0 R`;
    if (this.used.bold.size) fonts += ` /F4 ${fontObjects(unicodeFont(true), this.used.bold, add)} 0 R`;
    const kids: number[] = [];
    for (const ops of this.pages) {
      const content = ops.join('\n');
      const c = add(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
      kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4.width} ${A4.height}] /Resources << /Font << ${fonts} >> >> /Contents ${c} 0 R >>`));
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
