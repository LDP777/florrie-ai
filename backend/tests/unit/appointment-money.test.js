import { describe, it, expect } from 'vitest';
import { appointmentMoneyReport, appointmentPeriod } from '../../src/lib/appointment-money.js';
import { moneyTotals } from '../../src/lib/money-reporting.js';

const now = new Date('2026-11-22T10:00:00Z');
const row = (id, date, price, status = 'completed', extra = {}) => ({ id, starts_at: `${date}T12:00:00Z`, price_cents: price, status, ...extra });
const month = rows => appointmentMoneyReport(rows, { now }).periods.month;

describe('appointment value and received money', () => {
  it('counts the full treatment once, including its deposit, and separates the remaining diary', () => {
    const rows = [row('a', '2026-11-18', 4500, 'completed', { deposit_cents: 900, deposit_paid: true, discount_cents: 500 }), row('b', '2026-11-25', 3000, 'confirmed')];
    expect(month(rows)).toMatchObject({ total_cents: 7000, completed_cents: 4000, remaining_cents: 3000, total_count: 2, completed_count: 1, remaining_count: 1 });
    // Promotions reduce the booked price. Deposits are already part of it,
    // and completion does not confirm a receipt.
    expect(moneyTotals({ now, transactions: [{ id: 'assumed', type: 'payment', status: 'completed', amount_cents: 3600, created_at: '2026-11-18T13:00:00Z' }] }).income_cents).toBe(0);
  });
  it('includes saved add-ons, applies promotions once and keeps prepaid services in diary value', () => {
    expect(month([row('a', '2026-11-18', 4500, 'completed', { appointment_add_ons: [{ price_cents: 1000 }], discount_cents: 1100, discount_meta: { type: 'promo' } })]).total_cents).toBe(4400);
    expect(month([row('a', '2026-11-18', 4500, 'completed', { discount_cents: 4500, discount_meta: { type: 'voucher' } })]).total_cents).toBe(4500);
    expect(month([row('a', '2026-11-18', 4500, 'completed', { package_redemption: true })]).total_cents).toBe(4500);
    for (const extra of [{ discount_cents: 5000 }, { discount_cents: -1 }, { appointment_add_ons: [{ price_cents: null }] }]) {
      expect(month([row('a', '2026-11-18', 4500, 'completed', extra)]).total_cents).toBeNull();
    }
  });
  it('uses the appointment date regardless of when it was booked or completed', () => {
    expect(month([row('a', '2026-11-01', 3500, 'completed', { created_at: '2026-09-01', completed_at: '2026-11-20' }), row('b', '2026-10-31', 8000), row('c', '2026-12-01', 8000, 'confirmed')])).toMatchObject({ total_cents: 3500, completed_count: 1 });
  });
  it('excludes cancelled, no-show and unpaid reservations without hiding legitimate zero-priced work', () => {
    const rows = ['cancelled', 'no_show', 'pending_deposit', 'pending', 'deleted'].map((status, i) => row(String(i), '2026-11-10', 9000, status));
    rows.push(row('free', '2026-11-10', 0));
    expect(month(rows)).toMatchObject({ total_cents: 0, total_count: 1, missing_price_count: 0 });
  });
  it('keeps missing or invalid prices unknown instead of turning them into zero', () => {
    for (const value of [null, undefined, -500, NaN, 3.5, '3500']) {
      expect(month([row('a', '2026-11-10', value), row('b', '2026-11-25', 5000, 'confirmed')])).toMatchObject({ total_cents: null, completed_cents: null, remaining_cents: 5000, missing_price_count: 1 });
    }
  });
  it('flags overdue statuses and does not present a future completion as completed work', () => {
    expect(month([row('a', '2026-11-10', 3000, 'confirmed'), row('b', '2026-11-25', 6000)])).toMatchObject({ total_cents: null, completed_cents: 0, remaining_cents: 3000, status_review_count: 2 });
  });
  it('returns verified zero for an empty diary and rejects incomplete/repeated records', () => {
    expect(month([])).toMatchObject({ total_cents: 0, total_count: 0 });
    expect(() => month(null)).toThrow('unavailable');
    expect(() => month([row('a', '2026-11-10', 500), row('a', '2026-11-10', 500)])).toThrow('repeated');
    expect(() => month([row('a', 'not-a-date', 500)])).toThrow('date');
    expect(() => month([row('a', '2026-11-10', Number.MAX_SAFE_INTEGER), row('b', '2026-11-10', 500)])).toThrow('totals');
  });
});

describe('diary calendar boundaries', () => {
  it('includes the rest of the month and the rest of the week', () => {
    expect(appointmentPeriod('month', '2026-11-22')).toEqual({ start: '2026-11-01', end: '2026-11-30' });
    expect(appointmentPeriod('week', '2026-11-30')).toEqual({ start: '2026-11-30', end: '2026-12-06' });
    expect(appointmentPeriod('month', '2028-02-01').end).toBe('2028-02-29');
    expect(appointmentPeriod('month', '2026-12-31').end).toBe('2026-12-31');
  });
  it('does not apply BST a second time to a late appointment', () => {
    const report = appointmentMoneyReport([{ id: 'a', starts_at: '2026-08-31T23:30:00Z', status: 'confirmed', price_cents: 4000 }], { now: new Date('2026-08-31T12:00:00Z') });
    expect(report.periods.month.total_cents).toBe(4000);
  });
  it('uses the salon date when the device/server date is different', () => {
    const report = appointmentMoneyReport([row('a', '2026-11-30', 3000, 'confirmed')], { now: new Date('2026-12-01T02:00:00Z'), timezone: 'America/New_York' });
    expect(report.as_at).toBe('2026-11-30');
    expect(report.periods.month.total_cents).toBe(3000);
  });
});
