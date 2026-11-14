import { describe, it, expect } from 'vitest';
import { bookingChangeAccess, rescheduleWindow } from '../../src/lib/booking-self-service.js';

const appointment = (over = {}) => ({ status: 'confirmed', starts_at: '2026-10-24T12:00:00Z', policy_snapshot: { cancellation_notice_hours: 48 }, beauticians: { timezone: 'Europe/London' }, ...over });
describe('self-service booking deadlines', () => {
  it('uses the actual salon instant in BST, including the exact 48-hour boundary', () => {
    const atBoundary = bookingChangeAccess(appointment(), Date.parse('2026-10-22T11:00:00Z'));
    expect(atBoundary.canReschedule).toBe(true);
    expect(atBoundary.rescheduleDeadline).toBe('2026-10-22T11:00:00.000Z');
    expect(bookingChangeAccess(appointment(), Date.parse('2026-10-22T11:00:01Z')).canReschedule).toBe(false);
  });
  it('keeps the accepted snapshot and honours an explicit zero-hour window', () => {
    const a = appointment({ policy_snapshot: { cancellation_notice_hours: 0 }, beauticians: { timezone: 'Europe/London', booking_policy: { cancellation_notice_hours: 48 } } });
    expect(bookingChangeAccess(a, Date.parse('2026-10-24T10:00:00Z')).canReschedule).toBe(true);
    expect(bookingChangeAccess(a, Date.parse('2026-10-24T11:00:00Z')).canReschedule).toBe(false);
  });
  it('does not reopen a cancelled, past or already moved booking', () => {
    const now=Date.parse('2026-10-01T10:00:00Z');
    expect(bookingChangeAccess(appointment({status:'cancelled'}),now).canReschedule).toBe(false);
    expect(bookingChangeAccess(appointment({starts_at:'2026-09-01T12:00:00Z'}),now).canReschedule).toBe(false);
    expect(bookingChangeAccess(appointment({rescheduled_at:'2026-09-01',beauticians:{booking_policy:{reschedule_once:true}}}),now).reason).toBe('reschedule_used');
  });
});
describe('calendar month availability windows', () => {
  const nowWall = new Date('2026-10-01T09:00:00Z');
  const window = (month, policy = {}, livePolicy = {}) => rescheduleWindow({month,policy,livePolicy,nowWall});
  it('allows November from October even when it lies outside the former 28-day scan', () => {
    const result=window('2026-11');
    expect(result.fromWall.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(result.endWall.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(result.days).toBe(30);
    expect(result.latestMonth).toBe(null);
  });
  it('restricts navigation and dates to the stricter actual advance policy', () => {
    const result=window('2026-11',{max_advance_days:90},{max_advance_days:40});
    expect(result.latestMonth).toBe('2026-11');
    expect(result.endWall.toISOString()).toBe('2026-11-10T09:00:00.000Z');
    expect(window('2026-12',{max_advance_days:40}).code).toBe('month_outside_booking_window');
  });
  it('validates months and keeps the old-client no-month window bounded', () => {
    expect(window('2026-13').code).toBe('invalid_month');
    expect(window(['2026-11']).code).toBe('invalid_month');
    expect(window('2026-09').code).toBe('month_outside_booking_window');
    expect(window(undefined).days).toBe(28);
  });
});
