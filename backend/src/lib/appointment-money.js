import { moneyDate, periodWindow, shiftDate } from './money-reporting.js';

// Appointment value follows the date of the work. It is not a receipt, and
// must never enter cash totals, tax exports or the payment-collection guards.
export function appointmentPeriod(period, today) {
  const { start } = periodWindow(period, today);
  let end = today;
  if (period === 'week') end = shiftDate(start, 6);
  if (period === 'month') {
    const next = new Date(`${start}T12:00:00Z`);
    next.setUTCMonth(next.getUTCMonth() + 1);
    end = shiftDate(next.toISOString().slice(0, 10), -1);
  }
  return { start, end };
}

export function appointmentMoneyReport(appointments, { now = new Date(), timezone = 'Europe/London' } = {}) {
  if (!Array.isArray(appointments)) throw new Error('Appointment records are unavailable');
  const today = moneyDate(now, timezone), seen = new Set();
  const rows = appointments.filter(a => ['confirmed', 'completed'].includes(a.status)).map(a => {
    if (!a.id || seen.has(a.id)) throw new Error('Appointment records are incomplete or repeated');
    seen.add(a.id);
    // starts_at stores salon wall time in a UTC slot. Converting it again
    // would move late appointments into the following day during BST.
    const date = String(a.starts_at || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) !== date) {
      throw new Error('An appointment date could not be checked');
    }
    const cents = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
    const extras = a.appointment_add_ons ?? [];
    const discount = a.discount_cents ?? 0;
    let price = null;
    if (cents(a.price_cents) && cents(discount) && Array.isArray(extras) && extras.every(extra => cents(extra.price_cents))) {
      const gross = extras.reduce((sum, extra) => sum + extra.price_cents, a.price_cents);
      // Booking stores the combined treatment price before its promotion;
      // add-ons are separate rows. A voucher is prepaid tender, not a price
      // reduction. Package sessions likewise retain their booked service value.
      if (Number.isSafeInteger(gross) && discount <= gross) price = gross - (a.discount_meta?.type === 'voucher' ? 0 : discount);
    }
    return { ...a, date, price };
  });
  const amount = group => {
    if (group.some(a => a.price === null)) return null;
    const total = group.reduce((sum, a) => sum + a.price, 0);
    if (!Number.isSafeInteger(total)) throw new Error('Appointment totals could not be checked');
    return total;
  };
  const periods = Object.fromEntries(['today', 'week', 'month'].map(period => {
    const window = appointmentPeriod(period, today);
    const inPeriod = rows.filter(a => a.date >= window.start && a.date <= window.end);
    const futureCompleted = inPeriod.filter(a => a.status === 'completed' && a.date > today);
    const completed = inPeriod.filter(a => a.status === 'completed' && a.date <= today);
    const remaining = inPeriod.filter(a => a.status === 'confirmed');
    return [period, {
      ...window,
      total_cents: futureCompleted.length ? null : amount(inPeriod),
      completed_cents: amount(completed), remaining_cents: amount(remaining),
      total_count: inPeriod.length, completed_count: completed.length, remaining_count: remaining.length,
      missing_price_count: inPeriod.filter(a => a.price === null).length,
      status_review_count: futureCompleted.length + remaining.filter(a => a.date < today).length,
    }];
  }));
  return { as_at: today, timezone, periods };
}
