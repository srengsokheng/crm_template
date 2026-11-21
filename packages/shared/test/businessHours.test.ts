import { describe, expect, it } from 'vitest';
import { addBusinessMinutes, DEFAULT_WORKING_HOURS as WH, isValidTimeZone } from '../src/index.ts';

const iso = (d: Date) => d.toISOString().slice(0, 16);

describe('addBusinessMinutes', () => {
  it('counts only working time (Mon–Fri 09:00–17:00 UTC)', () => {
    // Wed 2026-11-11 10:00 + 2h → 12:00 same day
    expect(iso(addBusinessMinutes(new Date('2026-11-11T10:00:00Z'), 120, WH, 'UTC'))).toBe('2026-11-11T12:00');
    // Fri 16:00 + 2h → Mon 10:00
    expect(iso(addBusinessMinutes(new Date('2026-11-13T16:00:00Z'), 120, WH, 'UTC'))).toBe('2026-11-16T10:00');
    // Saturday → starts counting Monday 09:00
    expect(iso(addBusinessMinutes(new Date('2026-11-14T12:00:00Z'), 30, WH, 'UTC'))).toBe('2026-11-16T09:30');
    // Before opening → from 09:00; after closing → next day
    expect(iso(addBusinessMinutes(new Date('2026-11-11T06:00:00Z'), 60, WH, 'UTC'))).toBe('2026-11-11T10:00');
    expect(iso(addBusinessMinutes(new Date('2026-11-11T19:00:00Z'), 60, WH, 'UTC'))).toBe('2026-11-12T10:00');
    // A full working day (480 min) from Mon 09:00 → Mon 17:00; 2 days → Tue 17:00
    expect(iso(addBusinessMinutes(new Date('2026-11-16T09:00:00Z'), 480, WH, 'UTC'))).toBe('2026-11-16T17:00');
    expect(iso(addBusinessMinutes(new Date('2026-11-16T09:00:00Z'), 960, WH, 'UTC'))).toBe('2026-11-17T17:00');
  });

  it('uses the workspace time zone, including across a daylight-saving change', () => {
    // Phnom Penh is UTC+7: Fri 16:00 local (09:00Z) + 2h → Mon 10:00 local (03:00Z)
    expect(iso(addBusinessMinutes(new Date('2026-11-13T09:00:00Z'), 120, WH, 'Asia/Phnom_Penh'))).toBe('2026-11-16T03:00');
    // New York, DST ends Sun 2026-11-01: Fri 2026-10-30 16:00 EDT (20:00Z) + 2h → Mon 10:00 EST (15:00Z)
    expect(iso(addBusinessMinutes(new Date('2026-10-30T20:00:00Z'), 120, WH, 'America/New_York'))).toBe('2026-11-02T15:00');
  });

  it('handles custom hours, zero delay and misconfiguration', () => {
    const weekend = { days: [6, 7], start: '10:00', end: '14:00' };
    expect(iso(addBusinessMinutes(new Date('2026-11-11T12:00:00Z'), 60, weekend, 'UTC'))).toBe('2026-11-14T11:00');
    const d = new Date('2026-11-11T12:00:00Z');
    expect(addBusinessMinutes(d, 0, WH, 'UTC')).toBe(d);
    expect(iso(addBusinessMinutes(d, 60, { days: [], start: '09:00', end: '17:00' }, 'UTC'))).toBe('2026-11-11T13:00');
  });

  it('validates time zones', () => {
    expect(isValidTimeZone('Asia/Phnom_Penh')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });
});
