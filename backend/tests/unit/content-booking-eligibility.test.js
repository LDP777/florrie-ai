import { expect, it, vi } from 'vitest';
vi.mock('../../src/config.js', () => ({ supabase: {} }));
import { treatmentFitsBookingGap } from '../../src/lib/gap-availability.js';
const treatment = { booking_enabled: true, price_cents: 3000, duration_minutes: 30, buffer_minutes: 15 };
const now = new Date('2026-09-29T12:00:00Z'); // 13:00 in London.
function calendar(policy = {}, gaps = [{ date: '2026-09-29', start: '13:00', end: '15:00' }]) {
  return { beautician: { timezone: 'Europe/London', booking_policy: policy }, gaps };
}
it('honours notice in salon wall time and allows a later start within a gap', () => {
  expect(treatmentFitsBookingGap(treatment, calendar({ min_booking_hours: 1 }), now)).toBe(true);
  expect(treatmentFitsBookingGap(treatment, calendar({ min_booking_hours: 2 }), now)).toBe(false);
});
it('rounds to a bookable quarter hour and includes the treatment buffer', () => {
  const gaps = [{ date: '2026-09-29', start: '13:01', end: '13:59' }];
  expect(treatmentFitsBookingGap(treatment, calendar({}, gaps), now)).toBe(false);
  gaps[0].end = '14:00';
  expect(treatmentFitsBookingGap(treatment, calendar({}, gaps), now)).toBe(true);
});
it('respects the open diary horizon including its exact boundary', () => {
  const gaps = [{ date: '2026-09-30', start: '13:00', end: '15:00' }];
  expect(treatmentFitsBookingGap(treatment, calendar({ max_advance_days: 1 }, gaps), now)).toBe(true);
  gaps[0].start = '13:15';
  expect(treatmentFitsBookingGap(treatment, calendar({ max_advance_days: 1 }, gaps), now)).toBe(false);
  expect(treatmentFitsBookingGap(treatment, calendar({ max_advance_days: 0 }, gaps), now)).toBe(true);
});
it('does not infer eligibility from missing or malformed availability', () => {
  for (const value of [null, { gaps: [] }, calendar({ min_booking_hours: 'invalid' }), calendar({}, [{ date: 'bad', start: '13:00', end: '15:00' }])]) {
    expect(treatmentFitsBookingGap(treatment, value, now)).toBe(false);
  }
});
