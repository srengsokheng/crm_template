import { describe, expect, it } from 'vitest';
import { signaturePath, signatureSchema } from '../src/index.ts';

describe('drawn signatures', () => {
  it('accepts strokes inside the box and turns them into an SVG path', () => {
    const s = [[10, 50, 40, 20, 80, 70], [100, 40]];
    expect(signatureSchema.parse(s)).toEqual(s);
    expect(signaturePath(s)).toBe('M10 50 L40 20 L80 70 M100 40 L100.5 40');
  });

  it('refuses empty, dots-only, odd, out-of-the-box and oversized signatures', () => {
    expect(signatureSchema.safeParse([]).success).toBe(false);
    expect(signatureSchema.safeParse([[10, 10], [12, 11]]).success).toBe(false); // a dot is not a signature
    expect(signatureSchema.safeParse([[10, 10, 50]]).success).toBe(false); // odd number of values
    expect(signatureSchema.safeParse([[10, 10, 50, 101]]).success).toBe(false); // y over 100
    expect(signatureSchema.safeParse([[10, 10, 301, 50]]).success).toBe(false); // x over 300
    expect(signatureSchema.safeParse([[10.5, 10, 50, 50]]).success).toBe(false); // whole units only
    const huge = [Array.from({ length: 8002 }, (_, i) => (i % 2 ? 50 : i % 300))];
    expect(signatureSchema.safeParse(huge).success).toBe(false);
  });
});
