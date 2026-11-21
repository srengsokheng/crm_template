/**
 * Unicode text in PDFs: characters the built-in Helvetica can't draw are shaped with HarfBuzz and drawn with an
 * embedded TrueType font for their script. Only scripts in SCRIPTS are supported; anything else still prints as "?".
 *
 * Shaping matters for Khmer and Thai: subscript consonants, vowel signs, tone marks and diacritics are reordered and
 * stacked by the font's OpenType rules — drawing the characters one by one would print them in the wrong place.
 * To add a script: put its Noto Regular/Bold .ttf and licence in assets/fonts/ and add a line to SCRIPTS.
 */
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import * as hb from 'harfbuzzjs';
import { subsetFont } from './fontSubset.ts';

const FONT_DIR = new URL('../../assets/fonts/', import.meta.url);

/** Noto fonts, SIL Open Font License 1.1 (assets/fonts/OFL-*.txt). Earlier entries win where coverage overlaps. */
const SCRIPTS = [
  { name: 'Khmer', regular: 'NotoSansKhmer-Regular.ttf', bold: 'NotoSansKhmer-Bold.ttf' },
  { name: 'Thai', regular: 'NotoSansThai-Regular.ttf', bold: 'NotoSansThai-Bold.ttf' },
  { name: 'Lao', regular: 'NotoSansLao-Regular.ttf', bold: 'NotoSansLao-Bold.ttf' },
  // Latin letters Helvetica lacks (Vietnamese ư ơ ạ ế…, Polish ł, Turkish ş, …), plus Greek and Cyrillic.
  { name: 'Latin', regular: 'NotoSans-Regular.ttf', bold: 'NotoSans-Bold.ttf' },
] as const;
export const LATIN_SCRIPT = SCRIPTS.findIndex((s) => s.name === 'Latin');

export interface LoadedFont {
  baseName: string;
  data: Buffer;
  upem: number;
  font: hb.Font;
  bbox: [number, number, number, number];
  ascent: number;
  descent: number;
}

function load(file: string): LoadedFont {
  const data = readFileSync(new URL(file, FONT_DIR));
  const face = new hb.Face(new hb.Blob(data));
  const font = new hb.Font(face);
  const head = face.referenceTable('head')!;
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const ext = font.hExtents();
  return {
    baseName: file.replace(/\.ttf$/, ''),
    data, upem: face.upem, font,
    bbox: [view.getInt16(36), view.getInt16(38), view.getInt16(40), view.getInt16(42)],
    ascent: ext.ascender, descent: ext.descender,
  };
}

const fonts = SCRIPTS.map((s) => ({ regular: load(s.regular), bold: load(s.bold) }));
export const SCRIPT_COUNT = fonts.length;
/** The embedded font for a script (index into SCRIPTS). */
export const unicodeFont = (bold: boolean | undefined, script = 0) => (bold ? fonts[script].bold : fonts[script].regular);
/** A glyph's default advance (font units) — what a PDF viewer moves by after drawing it (the /W widths). */
export const glyphAdvance = (f: LoadedFont, gid: number) => f.font.glyphHAdvance(gid);

/** Does a script's font draw this code point? */
export const covers = (script: number, cp: number) => coverage[script].has(cp);
/** Which script font draws a code point (-1: none). Regular and bold cuts cover the same set. */
const coverage = fonts.map((f) => new Set(new hb.Face(new hb.Blob(f.regular.data)).collectUnicodes()));
export function scriptOf(cp: number): number {
  for (let i = 0; i < coverage.length; i++) if (coverage[i].has(cp)) return i;
  return -1;
}

export interface ShapedGlyph { gid: number; ax: number; dx: number; dy: number; text: string }
export interface Shaped { glyphs: ShapedGlyph[]; advance: number }

// textWidth() runs in loops (fitting, wrapping), so shaped runs are cached. Bounded: cleared when full.
const cache = new Map<string, Shaped>();

/** Shapes one run of text. Positions are in font units; `text` is the source text the glyph stands for (may be ''). */
export function shape(text: string, bold: boolean | undefined, script = 0): Shaped {
  const key = `${script}${bold ? 'b' : 'r'}${text}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const f = unicodeFont(bold, script);
  const buf = new hb.Buffer();
  buf.addText(text);
  buf.guessSegmentProperties();
  hb.shape(f.font, buf);
  const infos = buf.getGlyphInfosAndPositions();
  const glyphs: ShapedGlyph[] = infos.map((g) => ({ gid: g.codepoint, ax: g.xAdvance ?? 0, dx: g.xOffset ?? 0, dy: g.yOffset ?? 0, text: '' }));
  const advance = glyphs.reduce((sum, g) => sum + g.ax, 0);
  // Which characters each glyph stands for (for copy & search): a glyph that is a character's own glyph gets that
  // character; the rest of the cluster's characters (e.g. coeng + consonant → one subscript glyph) go to the cluster's
  // other glyphs. Cluster values are UTF-16 offsets; a cluster ends where the next cluster value starts.
  const starts = [...new Set(infos.map((g) => g.cluster))].sort((a, b) => a - b);
  for (const start of starts) {
    const end = starts.find((s) => s > start) ?? text.length;
    const members = glyphs.filter((_, i) => infos[i].cluster === start);
    const left = [...text.slice(start, end)];
    const nominal = new Set<ShapedGlyph>();
    for (const gl of members) {
      const i = left.findIndex((ch) => f.font.nominalGlyph(ch.codePointAt(0)!) === gl.gid);
      if (i >= 0) { gl.text = left[i]; left.splice(i, 1); nominal.add(gl); }
    }
    if (left.length) (members.find((gl) => !nominal.has(gl)) ?? members[members.length - 1]).text += left.join('');
  }
  if (cache.size > 2000) cache.clear();
  const out = { glyphs, advance };
  cache.set(key, out);
  return out;
}

const hex4 = (n: number) => n.toString(16).padStart(4, '0');
const utf16Hex = (s: string) => [...s].map((ch) => {
  const c = ch.codePointAt(0)!;
  if (c < 0x10000) return hex4(c);
  const v = c - 0x10000;
  return hex4(0xd800 + (v >> 10)) + hex4(0xdc00 + (v & 0x3ff));
}).join('');
/** A PDF text string as UTF-16BE hex (used for /ActualText and document info). */
export const pdfUnicodeString = (s: string) => `<FEFF${utf16Hex(s)}>`;

/**
 * The PDF objects for one embedded font (Type0 / CIDFontType2, Identity-H, glyph ids as CIDs). `used` maps each drawn
 * glyph id to the text it stands for, for copy & search (ToUnicode). `add` appends an object and returns its
 * number; the Type0 font object number is returned.
 */
export function fontObjects(f: LoadedFont, used: Map<number, string>, add: (body: string) => number): number {
  // Only the glyphs this document draws (ids unchanged); the whole font if subsetting fails.
  const gidList = [...used.keys()];
  const sub = subsetFont(f.data, gidList);
  const data = sub ?? f.data;
  // Subset fonts are named with a 6-letter tag (PDF 32000-1, 9.6.4), here derived from the glyph list.
  const tag = sub ? createHash('sha256').update(gidList.sort((a, b) => a - b).join(',')).digest().subarray(0, 6).reduce((s, b) => s + String.fromCharCode(65 + (b % 26)), '') + '+' : '';
  const fontName = tag + f.baseName;
  const compressed = deflateSync(data);
  const file = add(`<< /Length ${compressed.length} /Length1 ${data.length} /Filter /FlateDecode >>\nstream\n${compressed.toString('latin1')}\nendstream`);
  const k = 1000 / f.upem;
  const descriptor = add(`<< /Type /FontDescriptor /FontName /${fontName} /Flags 4 /FontBBox [${f.bbox.map((v) => Math.round(v * k)).join(' ')}] /ItalicAngle 0 /Ascent ${Math.round(f.ascent * k)} /Descent ${Math.round(f.descent * k)} /CapHeight ${Math.round(f.ascent * k)} /StemV 80 /FontFile2 ${file} 0 R >>`);
  const gids = [...used.keys()].sort((a, b) => a - b);
  const widths = gids.map((g) => `${g} [${Math.round(f.font.glyphHAdvance(g) * k)}]`).join(' ');
  const cid = add(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${fontName} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${descriptor} 0 R /CIDToGIDMap /Identity /DW 0 /W [${widths}] >>`);
  const mapped = gids.filter((g) => used.get(g));
  const chunks: string[] = [];
  for (let i = 0; i < mapped.length; i += 100) {
    const part = mapped.slice(i, i + 100);
    chunks.push(`${part.length} beginbfchar\n${part.map((g) => `<${hex4(g)}> <${utf16Hex(used.get(g)!)}>`).join('\n')}\nendbfchar`);
  }
  const cmap = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${chunks.join('\n')}\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`;
  const toUnicode = add(`<< /Length ${Buffer.byteLength(cmap, 'latin1')} >>\nstream\n${cmap}\nendstream`);
  return add(`<< /Type /Font /Subtype /Type0 /BaseFont /${fontName} /Encoding /Identity-H /DescendantFonts [${cid} 0 R] /ToUnicode ${toUnicode} 0 R >>`);
}
