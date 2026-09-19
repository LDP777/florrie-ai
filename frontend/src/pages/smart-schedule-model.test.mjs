import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSchedule, salonClock, scheduleRange, suggestionsForGap } from './smart-schedule-model.js';
const now = () => new Date('2026-09-21T08:00:00');
const hours = { mon: { start: '09:00', end: '17:00' } };
const base = extra => computeSchedule({ now: now(), workingHours: hours, treatments: [{ id: 't', duration_minutes: 30, is_active: true }], ...extra });
const appt = (start, end, more = {}) => ({ starts_at: `2026-09-21T${start}:00Z`, ends_at: `2026-09-21T${end}:00Z`, status: 'confirmed', ...more });

test('overlapping appointments use their actual end time and never reopen occupied time', () => {
  const result = base({ appointments: [appt('10:00', '12:00', { duration_minutes: 30 }), appt('10:30', '11:00'), appt('11:30', '13:00')] });
  assert.deepEqual(result.gaps.map(g => [g.start, g.end]), [['09:00', '10:00'], ['13:00', '17:00']]);
  assert.equal(result.bookedMinutes, 180); assert.equal(result.openMinutes, 300);
});
test('blocked ranges and ranged closures never become booked hours or offers', () => {
  const result = base({ exceptions: [{ date: '2026-09-21', type: 'amended', start_time: '12:00', end_time: '13:00', is_closed: true }], appointments: [appt('10:00', '11:00')] });
  assert.deepEqual(result.gaps.map(g => [g.start, g.end]), [['09:00', '10:00'], ['11:00', '12:00'], ['13:00', '17:00']]);
  assert.equal(result.blockedMinutes, 60); assert.equal(result.bookedMinutes, 60); assert.equal(result.workMinutes, 420);
  const closed = base({ exceptions: [{ date: '2026-09-19', end_date: '2026-09-23', type: 'closed' }] });
  assert.equal(closed.gaps.length, 0); assert.equal(closed.workMinutes, 0); assert.equal(closed.bookedMinutes, 0); assert.equal(closed.hasConfiguredHours, true);
});
test('off-hour and cross-midnight appointments are clipped to working windows', () => {
  const result = base({ appointments: [{ starts_at: '2026-09-20T23:30:00Z', ends_at: '2026-09-21T10:00:00Z', status: 'confirmed' }, appt('16:00', '19:00')] });
  assert.deepEqual(result.gaps.map(g => [g.start, g.end]), [['10:00', '16:00']]);
  assert.equal(result.bookedMinutes, 120);
});
test('cancelled and rescheduled rows are not occupied time', () => {
  const result = base({ appointments: [appt('10:00', '17:00', { status: 'rescheduled' }), appt('09:00', '17:00', { status: 'cancelled' })] });
  assert.equal(result.bookedMinutes, 0); assert.equal(result.gaps[0].duration_minutes, 480);
});
test('today starts at the next quarter hour and small gaps are not mislabelled booked', () => {
  const result = base({ now: new Date('2026-09-21T10:07:00'), appointments: [appt('10:20', '17:00')] });
  assert.equal(result.workMinutes, 405); assert.equal(result.openMinutes, 5); assert.equal(result.bookedMinutes, 400); assert.equal(result.gaps.length, 0);
  assert.equal(base({ now: new Date('2026-09-21T10:00:30') }).gaps[0].start, '10:15');
});
test('legacy day keys, disabled hours and stored padding match the booking rules', () => {
  const result = base({ workingHours: { Mon: hours.mon }, appointments: [{ starts_at: '2026-09-21T10:00:00Z', duration_minutes: 30, buffer_minutes: 10, extra_padding_minutes: 5, status: 'confirmed' }] });
  assert.deepEqual(result.gaps.map(g => [g.start, g.end]), [['09:00', '10:00'], ['10:45', '17:00']]);
  assert.equal(base({ workingHours: { mon: { ...hours.mon, enabled: false } } }).gaps.length, 0);
  assert.equal(base({ workingHours: { mon: { ...hours.mon, closed: true } } }).gaps.length, 0);
});
test('missing schedule is distinct from fully booked; malformed data never invents gaps', () => {
  const empty = base({ workingHours: null }); assert.equal(empty.hasConfiguredHours, false); assert.equal(empty.gaps.length, 0);
  assert.throws(() => base({ workingHours: { mon: { start: 'bad', end: '17:00' } } }), /working hours/);
  assert.throws(() => base({ appointments: [{ starts_at: '2026-09-21T10:00:00Z', status: 'confirmed' }] }), /valid end time/);
  assert.equal(base({ exceptions: [{ date: '2026-09-21', type: 'amended', start_time: '12:00' }] }).gaps.length, 0);
});
test('fit labels use active saved treatment durations and do not fabricate a price or duration', () => {
  const result = base({ treatments: [{ duration_minutes: 600 }, { duration_minutes: 30, is_active: false }, { duration_minutes: null }] });
  assert.equal(result.gaps[0].fitCount, 0); assert.equal(result.gaps[0].fitTotal, 2);
  const buffered = base({ treatments: [{ duration_minutes: 460, buffer_minutes: 30 }] });
  assert.equal(buffered.gaps[0].fitCount, 0);
});
test('waitlist hints must match the selected day and time, and every treatment must fit', () => {
  const gap = { date: '2026-09-21', start: '10:00', end: '11:00', duration_minutes: 60 };
  const candidate = { client: { id: 'c' }, treatment: { duration_minutes: 45 }, gap };
  const result = suggestionsForGap({ rebook_due: [candidate, { ...candidate, treatment: { duration_minutes: 45, buffer_minutes: 20 } }, { ...candidate, treatment: { duration_minutes: 90 } }], waitlist_match: [candidate, { ...candidate, gap: { ...gap, date: '2026-09-22' } }, { ...candidate, gap: { ...gap, end: '10:30' } }] }, gap);
  assert.equal(result.rebook_due.length, 1); assert.equal(result.waitlist_match.length, 1);
});
test('date range follows local dates, including midnight and month boundaries', () => {
  assert.deepEqual(scheduleRange(new Date('2026-09-30T00:15:00')), { from: '2026-09-30', until: '2026-10-07' });
  const clock = salonClock(new Date('2026-09-20T23:15:00Z'), 'Europe/London');
  assert.deepEqual(scheduleRange(clock), { from: '2026-09-21', until: '2026-09-28' });
  assert.equal(clock.getHours(), 0); assert.equal(clock.getMinutes(), 15);
  assert.deepEqual(scheduleRange(salonClock(new Date('2026-09-20T23:15:00Z'))), { from: '2026-09-21', until: '2026-09-28' });
});
