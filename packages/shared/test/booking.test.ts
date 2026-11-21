import { describe, expect, it } from 'vitest';
import { bookingSlots, customerWeekday, dateIn, icsEvent, slotStep, timeIn } from '../src/index.ts';

const hours = { days: [1, 2, 3, 4, 5], start: '09:00', end: '12:00' };

describe('booking slots', () => {
  it('offers times within the hours, after the notice, on working days only', () => {
    // Thursday 2026-11-19, 08:00 in Phnom Penh (UTC+7) = 01:00 UTC.
    const days = bookingSlots({ hours, duration: 60, tz: 'Asia/Phnom_Penh', now: new Date('2026-11-19T01:00:00Z'), minNoticeHours: 2, daysAhead: 4, busy: [] });
    expect(days.map((d) => d.date)).toEqual(['2026-11-19', '2026-11-20', '2026-11-23']); // weekend skipped; 4 days ahead = Mon 23
    // Today: from 10:00 (2 hours' notice), every 30 minutes, the last one ending at 12:00.
    expect(days[0].slots.map((s) => timeIn(s, 'Asia/Phnom_Penh'))).toEqual(['10:00', '10:30', '11:00']);
    expect(days[1].slots.map((s) => timeIn(s, 'Asia/Phnom_Penh'))).toEqual(['09:00', '09:30', '10:00', '10:30', '11:00']);
    expect(days[1].slots[0]).toBe('2026-11-20T02:00:00.000Z');
  });

  it('skips busy times, also partly overlapping ones', () => {
    const busy = [{ start: Date.parse('2026-11-20T03:15:00Z'), end: Date.parse('2026-11-20T03:45:00Z') }]; // 10:15–10:45 local
    const days = bookingSlots({ hours, duration: 30, tz: 'Asia/Phnom_Penh', now: new Date('2026-11-19T12:00:00Z'), minNoticeHours: 0, daysAhead: 1, busy });
    expect(days.find((d) => d.date === '2026-11-20')!.slots.map((s) => timeIn(s, 'Asia/Phnom_Penh'))).toEqual(['09:00', '09:30', '11:00', '11:30']);
  });

  it('steps, local dates, weekdays and the calendar file', () => {
    expect([15, 30, 45, 90].map(slotStep)).toEqual([15, 30, 30, 30]);
    expect(dateIn('2026-11-19T20:00:00Z', 'Asia/Phnom_Penh')).toBe('2026-11-20');
    expect(customerWeekday('en', '2026-11-20')).toBe('Fri');
    expect(customerWeekday('km', '2026-11-20')).toBe('សុក្រ');
    const ics = icsEvent({ uid: 'x@y', start: new Date('2026-11-20T02:00:00Z'), end: new Date('2026-11-20T03:00:00Z'), title: 'Demo, robots; arms', description: 'a\nb', location: 'Office' });
    expect(ics).toContain('DTSTART:20261120T020000Z\r\nDTEND:20261120T030000Z');
    expect(ics).toContain('SUMMARY:Demo\\, robots\\; arms');
    expect(ics).toContain('DESCRIPTION:a\\nb');
    expect(icsEvent({ uid: 'x', start: new Date(), end: new Date(), title: '', description: '', location: '', status: 'CANCELLED' })).toContain('METHOD:CANCEL');
  });
});
