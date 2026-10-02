import { describe, expect, it, vi } from 'vitest';
vi.mock('../../src/config.js', () => ({ supabase: {} }));
import { cancellationNoticeHours, isWithinCancellationWindow } from '../../src/lib/booking-policy.js';
import { planAppointmentChange } from '../../src/lib/appointment-message-scenario.js';
import { computePolicyFee } from '../../src/services/policy-fees.js';
import { cancellationNoticeHours as displayedNoticeHours, policyFeePercent } from '../../../frontend/src/lib/booking-policy.js';

describe('the saved cancellation notice has one interpretation', () => {
  it.each([undefined, null, '', ' ', false, {}, [], -1, '-2', NaN, Infinity, 'not a number'])('defaults invalid or absent %j to 48 hours', value => {
    expect(cancellationNoticeHours({ cancellation_notice_hours: value })).toBe(48);
    expect(displayedNoticeHours({ cancellation_notice_hours: value })).toBe(48);
  });

  it.each([0, '0', 24, '48', 72, 1.5])('honours an explicit valid notice of %j', value => {
    expect(cancellationNoticeHours({ cancellation_notice_hours: value })).toBe(Number(value));
    expect(displayedNoticeHours({ cancellation_notice_hours: value })).toBe(Number(value));
  });

  it('does not activate a disabled window for a same-day or past appointment', () => {
    for (const hours of [48, 1, 0, -1, -48]) expect(isWithinCancellationWindow(hours, { cancellation_notice_hours: 0 })).toBe(false);
  });

  it('preserves the exact boundary and the absent-value default', () => {
    expect(isWithinCancellationWindow(48, { cancellation_notice_hours: 48 })).toBe(false);
    expect(isWithinCancellationWindow(47.999, { cancellation_notice_hours: 48 })).toBe(true);
    expect(isWithinCancellationWindow(48, {})).toBe(false);
    expect(isWithinCancellationWindow(47.999, {})).toBe(true);
    expect(isWithinCancellationWindow(NaN, {})).toBe(false);
  });
});

describe('appointment-change replies respect the agreed notice snapshot', () => {
  const now = Date.parse('2026-10-02T10:00:00Z');
  const beautician = { first_name: 'Mara', booking_slug: 'fictional', timezone: 'UTC', booking_policy: { cancellation_notice_hours: 48 } };
  const appointment = { id: 'fictional-visit', starts_at: '2026-10-03T10:00:00Z', status: 'confirmed', management_token: 'fictional-token' };
  const plan = (snapshot, live = beautician.booking_policy) => planAppointmentChange({
    message: 'Please cancel my appointment', now,
    beautician: { ...beautician, booking_policy: live },
    context: { clientUpcoming: [{ ...appointment, policy_snapshot: snapshot }] },
  });

  it('offers the manage link for a zero-notice booking despite a new 48-hour policy', () => {
    expect(plan({ cancellation_notice_hours: 0 })).toMatchObject({ needsOwner: false, reason: 'booking_manage_link' });
  });

  it('keeps an old 48-hour booking inside its agreed window despite a new zero-notice policy', () => {
    expect(plan({ cancellation_notice_hours: 48 }, { cancellation_notice_hours: 0 })).toMatchObject({ needsOwner: true, reason: 'short_notice' });
  });

  it('uses the established default when the agreed snapshot omitted notice', () => {
    expect(plan({}, { cancellation_notice_hours: 0 })).toMatchObject({ needsOwner: true, reason: 'short_notice' });
  });
});

describe('the existing fee calculation still credits a paid deposit', () => {
  it.each([
    {}, { late_cancel_charge_percent: 0, no_show_charge_percent: 100 },
    { late_cancel_charge_percent: 100, no_show_charge_percent: 0 },
    { late_cancel_charge_percent: 50 }, { late_cancel_charge_percent: '25', no_show_charge_percent: null },
    { late_cancel_charge_percent: -1, no_show_charge_percent: 150 },
    { late_cancel_charge_percent: 'invalid', no_show_charge_percent: '50' },
  ])('shows the effective fee percentages used by payment handling for %j', policy => {
    for (const kind of ['late_cancel', 'no_show']) {
      expect(policyFeePercent(policy, kind)).toBe(computePolicyFee({ price_cents: 3500 }, policy, kind).percent);
    }
  });
  it('charges the remaining £28 of a £35 100% fee after a £7 paid deposit', () => {
    const appointment = { price_cents: 3500, deposit_cents: 700, deposit_paid: true };
    expect(computePolicyFee(appointment, { late_cancel_charge_percent: 100 }, 'late_cancel')).toEqual({ percent: 100, feeCents: 2800 });
    expect(computePolicyFee(appointment, { no_show_charge_percent: 100 }, 'no_show')).toEqual({ percent: 100, feeCents: 2800 });
  });

  it('does not credit an unpaid deposit or collect a negative fee', () => {
    expect(computePolicyFee({ price_cents: 3500, deposit_cents: 700, deposit_paid: false }, { late_cancel_charge_percent: 100 }, 'late_cancel').feeCents).toBe(3500);
    expect(computePolicyFee({ price_cents: 3500, deposit_cents: 4000, deposit_paid: true }, { late_cancel_charge_percent: 100 }, 'late_cancel').feeCents).toBe(0);
  });

  it('keeps no-show fees independent of a disabled cancellation notice', () => {
    expect(computePolicyFee({ price_cents: 3500, deposit_cents: 700, deposit_paid: true }, { cancellation_notice_hours: 0, late_cancel_charge_percent: 0, no_show_charge_percent: 100 }, 'no_show')).toEqual({ percent: 100, feeCents: 2800 });
  });
});
