/** Working hours of a workspace, used for automation delays that count only working time. */
export interface WorkingHours {
  /** ISO weekdays that are working days: 1 = Monday … 7 = Sunday. */
  days: number[];
  /** Local start and end of the working day, "HH:MM" (24h). */
  start: string;
  end: string;
}
export const DEFAULT_WORKING_HOURS: WorkingHours = { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' };

interface Local { y: number; m: number; d: number; h: number; mi: number; wd: number }

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short' });
    fmtCache.set(tz, f);
  }
  return f;
}
const WD: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** Wall-clock parts of an instant in a time zone. */
function local(t: number, tz: string): Local & { s: number } {
  const p = Object.fromEntries(fmt(tz).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second, wd: WD[p.weekday] };
}
/** UTC instant of a wall-clock time in a time zone (handles DST by re-checking the offset). */
function utcOf(y: number, m: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const offset = (t: number) => { const l = local(t, tz); return Date.UTC(l.y, l.m - 1, l.d, l.h, l.mi, l.s) - t; };
  let t = guess - offset(guess);
  t = guess - offset(t);
  return t;
}
const hm = (s: string) => { const [h, m] = s.split(':').map(Number); return [h, m] as const; };

export function isValidTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/**
 * Add `minutes` of working time to `start`. Time outside working hours (evenings, non-working days) is skipped;
 * a start outside hours begins counting at the next opening. Returns `start` unchanged for 0 minutes.
 */
export function addBusinessMinutes(start: Date, minutes: number, wh: WorkingHours, tz: string): Date {
  if (minutes <= 0) return start;
  const [sh, sm] = hm(wh.start);
  const [eh, em] = hm(wh.end);
  if (!wh.days.length || eh * 60 + em <= sh * 60 + sm) return new Date(start.getTime() + minutes * 60_000); // misconfigured → plain delay
  let t = start.getTime();
  let left = minutes;
  for (let guard = 0; guard < 3700; guard++) {
    const l = local(t, tz);
    const open = utcOf(l.y, l.m, l.d, sh, sm, tz);
    const close = utcOf(l.y, l.m, l.d, eh, em, tz);
    if (wh.days.includes(l.wd) && t < close) {
      if (t < open) t = open;
      const avail = (close - t) / 60_000;
      if (left <= avail) return new Date(t + left * 60_000);
      left -= avail;
    }
    // next local day 00:00 (Date.UTC normalises month/year overflow)
    const next = new Date(Date.UTC(l.y, l.m - 1, l.d + 1));
    t = utcOf(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, tz);
  }
  return new Date(t);
}
