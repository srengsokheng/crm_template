/**
 * Drawn signatures: a list of strokes, each a flat list of points [x0, y0, x1, y1, …] in whole units of a
 * SIGNATURE_BOX (300 × 100). Small to store, and drawn crisply as lines in PDFs and as SVG on screen.
 */
import { z } from 'zod';

export const SIGNATURE_BOX = { width: 300, height: 100 } as const;
const MAX_STROKES = 60;
const MAX_POINTS = 4000;

export const signatureSchema = z.array(z.array(z.number().int().min(0).max(SIGNATURE_BOX.width)).min(2).max(MAX_POINTS * 2))
  .min(1, 'Please sign in the box').max(MAX_STROKES, 'Too many strokes')
  .refine((s) => s.every((st) => st.length % 2 === 0 && st.every((v, i) => i % 2 === 0 || v <= SIGNATURE_BOX.height)), 'Invalid signature')
  .refine((s) => s.reduce((n, st) => n + st.length / 2, 0) <= MAX_POINTS, 'Signature too detailed')
  // A single dot isn't a signature: at least a little ink must cross the box.
  .refine((s) => {
    const xs = s.flatMap((st) => st.filter((_, i) => i % 2 === 0));
    return Math.max(...xs) - Math.min(...xs) >= 15;
  }, 'Please sign in the box');
export type Signature = z.infer<typeof signatureSchema>;

/** An SVG path ("M x y L x y …") for a signature, in SIGNATURE_BOX units. */
export function signaturePath(s: Signature): string {
  return s.map((st) => {
    const pts: string[] = [];
    for (let i = 0; i < st.length; i += 2) pts.push(`${i === 0 ? 'M' : 'L'}${st[i]} ${st[i + 1]}`);
    // A dot (one point) still shows as a tiny line.
    if (st.length === 2) pts.push(`L${st[0] + 0.5} ${st[1]}`);
    return pts.join(' ');
  }).join(' ');
}
