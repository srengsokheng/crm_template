/**
 * Font subsetting with HarfBuzz's hb-subset (the WebAssembly build shipped in harfbuzzjs, used through its C API
 * because harfbuzzjs has no JavaScript wrapper for it). PDFs embed only the glyphs they draw, with glyph ids kept
 * (RETAIN_GIDS), so the ids written in the page content stay valid. A 430 KB Latin font shrinks to a few KB.
 */
import { readFileSync } from 'node:fs';

interface SubsetExports {
  memory: WebAssembly.Memory;
  _initialize(): void;
  malloc(n: number): number;
  free(p: number): void;
  hb_blob_create(data: number, length: number, mode: number, userData: number, destroy: number): number;
  hb_blob_destroy(blob: number): void;
  hb_blob_get_length(blob: number): number;
  hb_blob_get_data(blob: number, lengthPtr: number): number;
  hb_face_create(blob: number, index: number): number;
  hb_face_destroy(face: number): void;
  hb_face_reference_blob(face: number): number;
  hb_set_add(set: number, value: number): void;
  hb_subset_input_create_or_fail(): number;
  hb_subset_input_destroy(input: number): void;
  hb_subset_input_glyph_set(input: number): number;
  hb_subset_input_set_flags(input: number, flags: number): void;
  hb_subset_or_fail(face: number, input: number): number;
}

const MEMORY_MODE_DUPLICATE = 0; // HarfBuzz copies the font bytes, so ours can be freed right away
const FLAG_NO_HINTING = 0x1;
const FLAG_RETAIN_GIDS = 0x2;

let ex: SubsetExports | null = null;
function wasm(): SubsetExports {
  if (ex) return ex;
  const bytes = readFileSync(new URL(import.meta.resolve('harfbuzzjs/dist/harfbuzz-subset.wasm')));
  const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
  ex = instance.exports as unknown as SubsetExports;
  ex._initialize();
  return ex;
}

/** The font reduced to the given glyphs (plus .notdef), glyph ids unchanged; null if HarfBuzz can't subset it. */
export function subsetFont(font: Buffer, glyphIds: Iterable<number>): Buffer | null {
  const w = wasm();
  const ptr = w.malloc(font.length);
  if (!ptr) return null;
  new Uint8Array(w.memory.buffer, ptr, font.length).set(font);
  const blob = w.hb_blob_create(ptr, font.length, MEMORY_MODE_DUPLICATE, 0, 0);
  w.free(ptr);
  const face = w.hb_face_create(blob, 0);
  w.hb_blob_destroy(blob);
  const input = w.hb_subset_input_create_or_fail();
  if (!input) { w.hb_face_destroy(face); return null; }
  const set = w.hb_subset_input_glyph_set(input);
  w.hb_set_add(set, 0);
  for (const g of glyphIds) w.hb_set_add(set, g);
  w.hb_subset_input_set_flags(input, FLAG_RETAIN_GIDS | FLAG_NO_HINTING);
  const sub = w.hb_subset_or_fail(face, input);
  w.hb_subset_input_destroy(input);
  w.hb_face_destroy(face);
  if (!sub) return null;
  const out = w.hb_face_reference_blob(sub);
  const len = w.hb_blob_get_length(out);
  const data = w.hb_blob_get_data(out, 0);
  // Copy out before freeing: the WebAssembly memory is reused.
  const result = len > 0 ? Buffer.from(new Uint8Array(w.memory.buffer, data, len)) : null;
  w.hb_blob_destroy(out);
  w.hb_face_destroy(sub);
  return result;
}
