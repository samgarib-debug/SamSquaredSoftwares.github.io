import { describe as group, expect, it } from 'vitest';
import { describe, publicHolidays, slotProblem } from '../src/booking.js';

// Thursday 22 October 2026, 08:00 SAST.
const NOW = Date.parse('2026-10-22T08:00:00+02:00');

group('publicHolidays', () => {
  it('lists every 2026 public holiday, including the Sunday rule and election day', () => {
    expect([...publicHolidays(2026)].sort()).toEqual([
      '2026-01-01', // New Year's Day
      '2026-03-21', // Human Rights Day (Saturday: no Monday off)
      '2026-04-03', // Good Friday
      '2026-04-06', // Family Day
      '2026-04-27', // Freedom Day
      '2026-05-01', // Workers' Day
      '2026-06-16', // Youth Day
      '2026-08-09', // National Women's Day (Sunday)
      '2026-08-10', // ...so Monday is a holiday
      '2026-09-24', // Heritage Day
      '2026-11-04', // Local government elections, declared
      '2026-12-16', // Day of Reconciliation
      '2026-12-25', // Christmas Day
      '2026-12-26', // Day of Goodwill
    ]);
  });

  it('moves Sunday holidays to Monday and finds Easter in 2027', () => {
    const days = publicHolidays(2027);
    expect(days).toContain('2027-03-22'); // Human Rights Day on a Sunday
    expect(days).toContain('2027-03-26'); // Good Friday
    expect(days).toContain('2027-03-29'); // Family Day
    expect(days).toContain('2027-12-27'); // Day of Goodwill on a Sunday
    expect(days).not.toContain('2027-11-04'); // the election day was 2026 only
    expect(days.size).toBe(14);
  });
});

group('slotProblem', () => {
  it.each([
    ['online', '2026-10-23T09:00+02:00'],
    ['online', '2026-10-23T09:30+02:00'],
    ['online', '2026-10-23T16:30+02:00'], // ends 17:00
    ['onsite', '2026-10-23T09:00+02:00'],
    ['onsite', '2026-10-23T16:00+02:00'], // ends 17:00
    ['online', '2026-10-22T09:00+02:00'], // later today is still bookable
    ['online', '2026-11-05T16:30+02:00'], // 14 days out
  ])('accepts %s at %s', (type, slot) => {
    expect(slotProblem(type, slot, NOW)).toBeNull();
  });

  it.each([
    ['phone', '2026-10-23T09:00+02:00', 'unknown_type'],
    ['online', '2026-10-23 09:00', 'bad_format'],
    ['online', '2026-10-23T09:00Z', 'bad_format'],
    ['online', '2026-10-23T09:00+00:00', 'bad_format'],
    ['online', '2026-02-30T09:00+02:00', 'bad_format'],
    ['online', '2026-10-24T10:00+02:00', 'weekend'], // Saturday
    ['online', '2026-10-25T10:00+02:00', 'weekend'], // Sunday
    ['online', '2026-11-04T10:00+02:00', 'public_holiday'], // election day
    ['onsite', '2026-12-16T10:00+02:00', 'public_holiday'],
    ['online', '2026-10-23T09:15+02:00', 'off_grid'],
    ['onsite', '2026-10-23T09:30+02:00', 'off_grid'],
    ['online', '2026-10-23T08:30+02:00', 'outside_hours'],
    ['online', '2026-10-23T17:00+02:00', 'outside_hours'],
    ['onsite', '2026-10-23T17:00+02:00', 'outside_hours'],
    ['online', '2026-10-22T07:30+02:00', 'outside_hours'],
    ['online', '2026-10-21T10:00+02:00', 'in_the_past'],
    ['online', '2026-11-09T10:00+02:00', 'too_far_ahead'],
  ])('rejects %s at %s: %s', (type, slot, reason) => {
    expect(slotProblem(type, slot, NOW)).toBe(reason);
  });

  it('rejects a slot that has just started', () => {
    const now = Date.parse('2026-10-23T09:00:00+02:00');
    expect(slotProblem('online', '2026-10-23T09:00+02:00', now)).toBe('in_the_past');
    expect(slotProblem('online', '2026-10-23T09:30+02:00', now)).toBeNull();
  });
});

group('describe', () => {
  it('reads like a person wrote it', () => {
    expect(describe('online', '2026-10-27T09:00+02:00')).toBe('Online demo (30 min), Tue 27 Oct 2026 at 09:00 SAST');
    expect(describe('onsite', '2026-11-02T14:00+02:00')).toBe('On-site call-out (60 min), Mon 2 Nov 2026 at 14:00 SAST');
    expect(describe('nope', '2026-11-02T14:00+02:00')).toBe('');
  });
});
