const moneyFmt = new Map<string, Intl.NumberFormat>();

export function money(value: string | number | null | undefined, currency = 'USD', opts: { compact?: boolean } = {}): string {
  if (value === null || value === undefined || value === '') return '—';
  const key = `${currency}:${opts.compact ? 'c' : 'f'}`;
  let f = moneyFmt.get(key);
  if (!f) {
    try {
      f = new Intl.NumberFormat('en-US', {
        style: 'currency', currency, maximumFractionDigits: opts.compact ? 1 : 2, minimumFractionDigits: 0,
        notation: opts.compact ? 'compact' : 'standard',
      });
    } catch {
      f = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
    }
    moneyFmt.set(key, f);
  }
  return f.format(Number(value));
}

export const number = (v: number | string | null | undefined) => (v === null || v === undefined ? '—' : new Intl.NumberFormat('en-US').format(Number(v)));

export function date(v: string | Date | null | undefined, opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' }): string {
  if (!v) return '—';
  const d = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00`) : new Date(v);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-US', opts);
}

export function dateTime(v: string | Date | null | undefined): string {
  if (!v) return '—';
  const d = new Date(v);
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function relative(v: string | Date | null | undefined): string {
  if (!v) return '—';
  const d = new Date(v).getTime();
  const diff = d - Date.now();
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [['year', 31536e6], ['month', 2592e6], ['week', 6048e5], ['day', 864e5], ['hour', 36e5], ['minute', 6e4]];
  for (const [u, ms] of units) if (abs >= ms) return rtf.format(Math.round(diff / ms), u);
  return 'just now';
}

export function dueLabel(v: string | null | undefined): { text: string; tone: 'overdue' | 'today' | 'future' | 'none' } {
  if (!v) return { text: 'No date', tone: 'none' };
  const d = new Date(v);
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t = d.getTime();
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (t < now.getTime()) return { text: t >= startToday ? `Today ${time}` : `${date(v, { month: 'short', day: 'numeric' })}`, tone: 'overdue' };
  if (t < startToday + 864e5) return { text: `Today ${time}`, tone: 'today' };
  if (t < startToday + 2 * 864e5) return { text: `Tomorrow ${time}`, tone: 'future' };
  return { text: date(v, { weekday: 'short', month: 'short', day: 'numeric' }), tone: 'future' };
}

export const personName = (first?: string | null, last?: string | null) => [first, last].filter(Boolean).join(' ') || 'Unnamed';
export const initials = (name?: string | null) =>
  (name ?? '?').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('') || '?';

/** Local datetime-input value ⇄ ISO string */
export function toLocalInput(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : null);
