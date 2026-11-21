import { describe, expect, it } from 'vitest';
import { periodRange } from '../src/period.ts';

describe('periodRange', () => {
  it('resolves named periods, across year ends and leap years', () => {
    expect(periodRange('month', '2026-11-20')).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect(periodRange('last_month', '2026-01-15')).toEqual({ from: '2025-12-01', to: '2025-12-31' });
    expect(periodRange('month', '2028-02-10')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(periodRange('quarter', '2026-11-20')).toEqual({ from: '2026-10-01', to: '2026-12-31' });
    expect(periodRange('last_quarter', '2026-02-01')).toEqual({ from: '2025-10-01', to: '2025-12-31' });
    expect(periodRange('year', '2026-06-30')).toEqual({ from: '2026-01-01', to: '2026-12-31' });
    expect(periodRange('last_year', '2026-06-30')).toEqual({ from: '2025-01-01', to: '2025-12-31' });
    expect(periodRange('custom', '2026-06-30')).toBeNull();
  });
});
