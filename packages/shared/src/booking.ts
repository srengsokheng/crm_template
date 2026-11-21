/**
 * Online booking: free times of a booking page. Times are offered in the workspace's time zone, every `step` minutes
 * within the page's hours, at least `minNoticeHours` from now, up to `daysAhead` days ahead, and never overlapping
 * the host's busy times (meetings and calls in the CRM, other bookings).
 */
import { local, utcOf, type WorkingHours } from './businessHours.ts';

export interface SlotInput {
  hours: WorkingHours; duration: number; tz: string; now: Date; minNoticeHours: number; daysAhead: number;
  /** Busy intervals in epoch ms. */
  busy: { start: number; end: number }[];
}
export interface SlotDay { date: string; slots: string[] }

const hm = (s: string) => s.split(':').map(Number) as [number, number];
/** Slot spacing: the meeting length up to 30 minutes, then every half hour. */
export const slotStep = (duration: number) => Math.min(duration, 30);

export function bookingSlots(o: SlotInput): SlotDay[] {
  const out: SlotDay[] = [];
  const earliest = o.now.getTime() + o.minNoticeHours * 3_600_000;
  const [sh, sm] = hm(o.hours.start);
  const [eh, em] = hm(o.hours.end);
  const step = slotStep(o.duration) * 60_000;
  const len = o.duration * 60_000;
  const today = local(o.now.getTime(), o.tz);
  for (let i = 0; i <= o.daysAhead; i++) {
    const day = new Date(Date.UTC(today.y, today.m - 1, today.d + i));
    const y = day.getUTCFullYear(), m = day.getUTCMonth() + 1, d = day.getUTCDate();
    const wd = ((day.getUTCDay() + 6) % 7) + 1;
    if (!o.hours.days.includes(wd)) continue;
    const open = utcOf(y, m, d, sh, sm, o.tz);
    const close = utcOf(y, m, d, eh, em, o.tz);
    const slots: string[] = [];
    for (let t = open; t + len <= close; t += step) {
      if (t < earliest) continue;
      if (o.busy.some((b) => t < b.end && t + len > b.start)) continue;
      slots.push(new Date(t).toISOString());
    }
    if (slots.length) out.push({ date: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`, slots });
  }
  return out;
}

/** Wall-clock "HH:MM" of an instant in a time zone. */
export function timeIn(iso: string | Date, tz: string): string {
  const l = local(new Date(iso).getTime(), tz);
  return `${String(l.h).padStart(2, '0')}:${String(l.mi).padStart(2, '0')}`;
}
/** Local date "YYYY-MM-DD" of an instant in a time zone. */
export function dateIn(iso: string | Date, tz: string): string {
  const l = local(new Date(iso).getTime(), tz);
  return `${l.y}-${String(l.m).padStart(2, '0')}-${String(l.d).padStart(2, '0')}`;
}

/** A calendar file (.ics) for one booked meeting. */
export function icsEvent(o: { uid: string; start: Date; end: Date; title: string; description: string; location: string; status?: 'CONFIRMED' | 'CANCELLED'; sequence?: number }): string {
  const f = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Acme CRM//Booking//EN', `METHOD:${o.status === 'CANCELLED' ? 'CANCEL' : 'PUBLISH'}`, 'BEGIN:VEVENT',
    `UID:${o.uid}`, `SEQUENCE:${o.sequence ?? 0}`, `DTSTAMP:${f(new Date())}`, `DTSTART:${f(o.start)}`, `DTEND:${f(o.end)}`, `SUMMARY:${esc(o.title)}`,
    `DESCRIPTION:${esc(o.description)}`, `LOCATION:${esc(o.location)}`, `STATUS:${o.status ?? 'CONFIRMED'}`,
    'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
}
