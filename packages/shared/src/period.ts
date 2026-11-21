/** Reporting periods for the dashboard: named ranges resolved against a day (YYYY-MM-DD), inclusive on both ends. */
export const PERIODS = ['month', 'last_month', 'quarter', 'last_quarter', 'year', 'last_year', 'custom'] as const;
export type PeriodKind = (typeof PERIODS)[number];

export const PERIOD_LABEL: Record<PeriodKind, string> = {
  month: 'This month', last_month: 'Last month', quarter: 'This quarter', last_quarter: 'Last quarter',
  year: 'This year', last_year: 'Last year', custom: 'Custom',
};

const iso = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);

/** The first and last day of a named period that contains (or precedes) `today`. Custom returns null. */
export function periodRange(kind: PeriodKind, today: string): { from: string; to: string } | null {
  const [y, m] = today.split('-').map(Number);
  const mo = m - 1;
  const q = Math.floor(mo / 3) * 3;
  switch (kind) {
    case 'month': return { from: iso(y, mo, 1), to: iso(y, mo + 1, 0) };
    case 'last_month': return { from: iso(y, mo - 1, 1), to: iso(y, mo, 0) };
    case 'quarter': return { from: iso(y, q, 1), to: iso(y, q + 3, 0) };
    case 'last_quarter': return { from: iso(y, q - 3, 1), to: iso(y, q, 0) };
    case 'year': return { from: iso(y, 0, 1), to: iso(y, 11, 31) };
    case 'last_year': return { from: iso(y - 1, 0, 1), to: iso(y - 1, 11, 31) };
    default: return null;
  }
}
