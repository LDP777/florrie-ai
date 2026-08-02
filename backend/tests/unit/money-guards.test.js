import { describe, it, expect } from 'vitest';
import {
  PRICE_SETTLED_TYPES,
  BOOKING_MONEY_LOGGED_TYPES,
  completionTakingsCents,
  onlyFlipped,
  disputeTag,
  disputeWonTag,
  hasTag,
  recordedRefundCents,
  refundDeltaCents,
  buildRefundTransaction,
  buildDisputeReversalTransaction,
} from '../../src/lib/money-guards.js';

// These pin the rules that decide whether money gets counted once, twice or
// not at all. Every case below maps to something that actually went wrong.

// The live CHECK constraint on transactions.type, per migration 076. A type
// outside this set is rejected by Postgres and the row silently vanishes,
// which is exactly what happened to every product_sale before 076.
const ALLOWED_TYPES = [
  'payment', 'deposit', 'no_show_fee', 'refund', 'tip',
  'full_payment', 'payment_link', 'late_cancel_fee', 'product_sale',
];
const ALLOWED_PAYMENT_METHODS = ['card_online', 'card_terminal', 'tap_to_pay', 'cash', 'bank_transfer'];

describe('guard type lists agree', () => {
  it('only ever names types the CHECK constraint allows', () => {
    for (const t of [...PRICE_SETTLED_TYPES, ...BOOKING_MONEY_LOGGED_TYPES]) {
      expect(ALLOWED_TYPES).toContain(t);
    }
  });

  it('includes payment_link in both lists', () => {
    // The bug: auto-complete checked ['payment','full_payment'] only, so a
    // client who paid by link got a second income row logged on top.
    expect(PRICE_SETTLED_TYPES).toContain('payment_link');
    expect(BOOKING_MONEY_LOGGED_TYPES).toContain('payment_link');
  });

  it('treats a settled price as settled however it was settled', () => {
    expect([...PRICE_SETTLED_TYPES].sort()).toEqual(['full_payment', 'payment', 'payment_link']);
  });

  it('counts a deposit as booking money but not as a settled price', () => {
    // A deposit does NOT settle the price, so it must not block a remaining
    // balance charge. It DOES mean the booking money is logged, so it must
    // block a second deposit row.
    expect(BOOKING_MONEY_LOGGED_TYPES).toContain('deposit');
    expect(PRICE_SETTLED_TYPES).not.toContain('deposit');
  });

  it('is frozen, so no caller can mutate the shared list', () => {
    expect(Object.isFrozen(PRICE_SETTLED_TYPES)).toBe(true);
    expect(Object.isFrozen(BOOKING_MONEY_LOGGED_TYPES)).toBe(true);
  });
});

describe('completionTakingsCents', () => {
  it('logs the remainder, not the full price, when a deposit was paid', () => {
    // The one-tap complete route logged 4500 here while the cron logged 3500,
    // so the same booking reported different income depending on the path.
    expect(completionTakingsCents({ price_cents: 4500, deposit_cents: 1000, deposit_paid: true })).toBe(3500);
  });

  it('logs the full price when no deposit was paid', () => {
    expect(completionTakingsCents({ price_cents: 4500, deposit_cents: 1000, deposit_paid: false })).toBe(4500);
  });

  it('never goes negative when the deposit exceeds the price', () => {
    expect(completionTakingsCents({ price_cents: 1000, deposit_cents: 4500, deposit_paid: true })).toBe(0);
  });

  it('treats missing figures as zero rather than NaN', () => {
    expect(completionTakingsCents({})).toBe(0);
    expect(completionTakingsCents(null)).toBe(0);
    expect(completionTakingsCents({ price_cents: 4500, deposit_paid: true })).toBe(4500);
  });
});

describe('onlyFlipped', () => {
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('keeps only the rows this request flipped', () => {
    // The cron flipped 'b' between our read and our write. Counting its visit
    // and its takings again is the double count.
    expect(onlyFlipped(rows, new Set(['a', 'c']))).toEqual([{ id: 'a' }, { id: 'c' }]);
  });

  it('returns nothing when the cron got there first', () => {
    expect(onlyFlipped(rows, new Set())).toEqual([]);
  });

  it('accepts an array of ids as well as a Set', () => {
    expect(onlyFlipped(rows, ['b'])).toEqual([{ id: 'b' }]);
  });

  it('survives a null row list', () => {
    expect(onlyFlipped(null, ['a'])).toEqual([]);
  });
});

describe('refund transaction shape', () => {
  const base = {
    beauticianId: 'b1',
    appointmentId: 'appt1',
    clientId: 'c1',
    amountCents: 1500,
    paymentIntentId: 'pi_1',
    chargeId: 'ch_1',
  };

  it('writes money out as a negative amount', () => {
    expect(buildRefundTransaction(base).amount_cents).toBe(-1500);
  });

  it('normalises an amount that is already negative', () => {
    expect(buildRefundTransaction({ ...base, amountCents: -1500 }).amount_cents).toBe(-1500);
  });

  it('uses a type the CHECK constraint allows', () => {
    // There is no 'dispute' or 'chargeback' member, so a dispute is a 'refund'
    // identified by its description tag.
    const row = buildRefundTransaction(base);
    expect(row.type).toBe('refund');
    expect(ALLOWED_TYPES).toContain(row.type);
  });

  it('uses card_online, never plain card', () => {
    // payment_method 'card' is not in the CHECK constraint and rejected every
    // card row for weeks.
    const row = buildRefundTransaction(base);
    expect(row.payment_method).toBe('card_online');
    expect(ALLOWED_PAYMENT_METHODS).toContain(row.payment_method);
  });

  it('keys the row off the payment intent so the guard can find it again', () => {
    const row = buildRefundTransaction(base);
    expect(row.stripe_payment_intent_id).toBe('pi_1');
    expect(row.stripe_charge_id).toBe('ch_1');
  });

  it('omits optional columns rather than writing nulls into them', () => {
    const row = buildRefundTransaction(base);
    expect('description' in row).toBe(false);
    expect('tax_year' in row).toBe(false);
  });

  it('reverses a won dispute with a positive amount', () => {
    const row = buildDisputeReversalTransaction({ ...base, description: disputeWonTag('du_1') });
    expect(row.amount_cents).toBe(1500);
    expect(row.type).toBe('refund');
  });
});

describe('refund dedupe', () => {
  const refundRow = (amount, description = null) => ({ amount_cents: amount, description });

  it('records nothing when the same refund arrives twice', () => {
    // POST /api/stripe/refund writes it, then the charge.refunded webhook
    // arrives seconds later with the same running total.
    const prior = [refundRow(2000), refundRow(-1500)];
    expect(refundDeltaCents(1500, prior)).toBe(0);
  });

  it('records only the difference on a second partial refund', () => {
    const prior = [refundRow(4500), refundRow(-1500)];
    expect(refundDeltaCents(2500, prior)).toBe(1000);
  });

  it('records the whole amount when nothing is on file yet', () => {
    expect(refundDeltaCents(1500, [refundRow(4500)])).toBe(1500);
    expect(refundDeltaCents(1500, [])).toBe(1500);
    expect(refundDeltaCents(1500, null)).toBe(1500);
  });

  it('never returns a negative delta when Stripe reports less than we hold', () => {
    expect(refundDeltaCents(500, [refundRow(-1500)])).toBe(0);
  });

  it('does not let a chargeback mask a genuine refund', () => {
    // A dispute is money taken by the bank, not a refund Ellie granted.
    const prior = [refundRow(4500), refundRow(-4500, `${disputeTag('du_1')} Disputed by the client`)];
    expect(recordedRefundCents(prior)).toBe(0);
    expect(refundDeltaCents(1500, prior)).toBe(1500);
  });
});

describe('dispute tags', () => {
  it('recognises a dispute it has already written', () => {
    const rows = [{ description: `${disputeTag('du_1')} Disputed by the client` }];
    expect(hasTag(rows, disputeTag('du_1'))).toBe(true);
  });

  it('does not confuse two different disputes', () => {
    const rows = [{ description: `${disputeTag('du_1')} Disputed by the client` }];
    expect(hasTag(rows, disputeTag('du_2'))).toBe(false);
  });

  it('keeps the opening row and the won reversal apart', () => {
    // Same dispute, two events. Writing the reversal must not be blocked by
    // the opening row, and vice versa.
    const opened = [{ description: `${disputeTag('du_1')} Disputed by the client` }];
    expect(hasTag(opened, disputeWonTag('du_1'))).toBe(false);
    const won = [{ description: `${disputeWonTag('du_1')} Dispute won` }];
    expect(hasTag(won, disputeWonTag('du_1'))).toBe(true);
  });

  it('is false for rows with no description at all', () => {
    expect(hasTag([{ description: null }, {}], disputeTag('du_1'))).toBe(false);
    expect(hasTag(null, disputeTag('du_1'))).toBe(false);
    expect(hasTag([{ description: 'x' }], null)).toBe(false);
  });
});
