import { describe, expect, it } from 'vitest';
import * as S from '../src/schemas.ts';

describe('update (PATCH) schemas', () => {
  it('never fill in defaults for fields that were not sent', () => {
    for (const [name, schema] of Object.entries(S)) {
      if (!/UpdateSchema$/.test(name)) continue;
      const r = (schema as { safeParse: (v: unknown) => { success: boolean; data?: Record<string, unknown> } }).safeParse({});
      if (r.success) expect(r.data, name).toEqual({});
    }
  });
  it('still validate what is sent', () => {
    expect(S.productUpdateSchema.safeParse({ unitPrice: 'abc' }).success).toBe(false);
    expect(S.automationRuleUpdateSchema.parse({ isEnabled: false })).toEqual({ isEnabled: false });
  });
});
