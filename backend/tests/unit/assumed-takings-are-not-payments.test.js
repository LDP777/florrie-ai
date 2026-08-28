/**
 * 27 August 2026. The pilot salon owner asked her founder, in as many words:
 * "How do I charge someone's card on Florrie after it says it's completed?"
 *
 * She could not, and underneath that question sat something worse than a
 * missing button. Finishing a booking writes a type 'payment' transaction so
 * the Money tab adds up (lib/takings.js). Nobody hands anything over at that
 * moment: the row is Florrie ASSUMING she was paid in the room because the
 * treatment ended. It carries no payment_method and no Stripe payment intent.
 *
 * Nothing in the codebase could tell that row apart from GBP 45 that had really
 * left a client's card, so:
 *
 *   - chargeRemainingBalance answered 'already_charged' on every completed
 *     booking, for money that had never touched a card;
 *   - the Money tab printed the guess in the same ink as the fact, so a week
 *     could read GBP 400 taken with nothing in anyone's account.
 *
 * These are the rules that make the two different things. They are pure, and
 * they are deliberately pure: this is the arithmetic her tax bill rests on.
 */
import { describe, it, expect } from 'vitest';
import { buildLedger } from '../../src/lib/ledger.js';
import {
  isAssumedTakingsRow,
  isSettledPriceRow,
  assumedTakingsCents,
  settledPriceCents,
  uncollectedCents,
  supersedeAssumedPlan,
  INCOME_TYPES,
} from '../../src/lib/money-guards.js';

/** Exactly what lib/takings.js writes when a booking is completed. */
const assumedRow = (over = {}) => ({
  id: 'tx_assumed',
  type: 'payment',
  amount_cents: 4500,
  payment_method: null,
  stripe_payment_intent_id: null,
  ...over,
});

/** Exactly what policy-fees.js writes when a card is really charged. */
const cardRow = (over = {}) => ({
  id: 'tx_card',
  type: 'payment',
  amount_cents: 4500,
  payment_method: 'card_online',
  stripe_payment_intent_id: 'pi_real',
  ...over,
});

describe('an assumption and a payment are not the same row', () => {
  it('calls the completion row what it is', () => {
    expect(isAssumedTakingsRow(assumedRow())).toBe(true);
    expect(isSettledPriceRow(assumedRow())).toBe(false);
  });

  it('calls a real card charge settled', () => {
    expect(isSettledPriceRow(cardRow())).toBe(true);
    expect(isAssumedTakingsRow(cardRow())).toBe(false);
  });

  it('treats cash she keyed in herself as settled, not as a guess', () => {
    // No payment intent, because no card was involved. But a human said "she
    // gave me the cash", and that is evidence. Only a row where NOBODY said
    // anything is an assumption.
    const cash = assumedRow({ id: 'tx_cash', payment_method: 'cash' });
    expect(isSettledPriceRow(cash)).toBe(true);
    expect(isAssumedTakingsRow(cash)).toBe(false);
  });

  it('will not call a payment intent an assumption just because the method column is empty', () => {
    // The 'card' CHECK-constraint incident left rows whose method insert was
    // rejected. Money moved. The intent id proves it, and it must win.
    const orphan = assumedRow({ id: 'tx_orphan', stripe_payment_intent_id: 'pi_1' });
    expect(isAssumedTakingsRow(orphan)).toBe(false);
    expect(isSettledPriceRow(orphan)).toBe(true);
  });

  it('ignores rows that are not the treatment price at all', () => {
    // A deposit, a tip and a no-show fee are their own money. None of them says
    // anything about whether the price was settled, in either direction.
    for (const type of ['deposit', 'tip', 'no_show_fee', 'late_cancel_fee', 'product_sale', 'refund']) {
      const row = assumedRow({ type });
      expect(isAssumedTakingsRow(row)).toBe(false);
      expect(isSettledPriceRow(row)).toBe(false);
    }
  });

  it('survives the shapes a database actually returns', () => {
    expect(isAssumedTakingsRow(null)).toBe(false);
    expect(isAssumedTakingsRow(undefined)).toBe(false);
    expect(isAssumedTakingsRow({})).toBe(false);
    expect(isSettledPriceRow(null)).toBe(false);
    expect(assumedTakingsCents(null)).toBe(0);
    expect(settledPriceCents(undefined)).toBe(0);
  });
});

describe('what is still collectable', () => {
  it('does not let an assumption reduce it, which is the whole point', () => {
    // This is the fix to the question she asked. GBP 45 completed, GBP 45
    // assumed, and GBP 45 still genuinely collectable, so the charge button has
    // something to do.
    expect(uncollectedCents(4500, [assumedRow()])).toBe(4500);
  });

  it('lets a real payment reduce it to nothing', () => {
    expect(uncollectedCents(4500, [cardRow()])).toBe(0);
  });

  it('nets a part payment off, and never goes below zero', () => {
    expect(uncollectedCents(4500, [cardRow({ amount_cents: 2000 })])).toBe(2500);
    expect(uncollectedCents(4500, [cardRow({ amount_cents: 9900 })])).toBe(0);
  });

  it('counts the assumption and the payment separately when both exist', () => {
    const rows = [assumedRow({ amount_cents: 4500 }), cardRow({ amount_cents: 1000 })];
    expect(assumedTakingsCents(rows)).toBe(4500);
    expect(settledPriceCents(rows)).toBe(1000);
    expect(uncollectedCents(4500, rows)).toBe(3500);
  });
});

describe('what happens to the guess when the money is real', () => {
  it('retracts an assumption the charge fully covers', () => {
    const plan = supersedeAssumedPlan([assumedRow()], 4500);
    expect(plan.deleteIds).toEqual(['tx_assumed']);
    expect(plan.reduce).toEqual([]);
    expect(plan.supersededCents).toBe(4500);
  });

  it('reduces it when the charge covers only part', () => {
    const plan = supersedeAssumedPlan([assumedRow()], 2000);
    expect(plan.deleteIds).toEqual([]);
    expect(plan.reduce).toEqual([{ id: 'tx_assumed', amountCents: 2500 }]);
    expect(plan.supersededCents).toBe(2000);
  });

  it('never cancels more guesswork than there was', () => {
    // She charges GBP 60 on a GBP 45 booking (a top-up, a second treatment).
    // The extra GBP 15 is real income of its own and must survive; it just has
    // no assumption left to cancel.
    const plan = supersedeAssumedPlan([assumedRow()], 6000);
    expect(plan.deleteIds).toEqual(['tx_assumed']);
    expect(plan.supersededCents).toBe(4500);
  });

  it('spends the oldest assumption first', () => {
    const rows = [
      assumedRow({ id: 'tx_old', amount_cents: 1000 }),
      assumedRow({ id: 'tx_new', amount_cents: 4000 }),
    ];
    const plan = supersedeAssumedPlan(rows, 2000);
    expect(plan.deleteIds).toEqual(['tx_old']);
    expect(plan.reduce).toEqual([{ id: 'tx_new', amountCents: 3000 }]);
  });

  it('refuses to touch a real payment, whatever it is handed', () => {
    // Belt and braces: this plan drives DELETE statements against the money
    // table. Passing it a settled row must produce no instruction at all.
    const plan = supersedeAssumedPlan([cardRow()], 4500);
    expect(plan.deleteIds).toEqual([]);
    expect(plan.reduce).toEqual([]);
    expect(plan.supersededCents).toBe(0);
  });

  it('does nothing on a zero or nonsense charge', () => {
    for (const amount of [0, -100, null, undefined, NaN, 'oops']) {
      const plan = supersedeAssumedPlan([assumedRow()], amount);
      expect(plan.deleteIds).toEqual([]);
      expect(plan.reduce).toEqual([]);
      expect(plan.supersededCents).toBe(0);
    }
  });

  it('leaves her income right whichever way the charge lands', () => {
    // The property that matters. Apply the plan, add up what INCOME_TYPES would
    // count, and the answer is the charge plus whatever assumption survived it,
    // never the two stacked on top of each other.
    const apply = (rows, chargedCents) => {
      const plan = supersedeAssumedPlan(rows.filter(isAssumedTakingsRow), chargedCents);
      const reduced = new Map(plan.reduce.map(r => [r.id, r.amountCents]));
      const kept = rows
        .filter(r => !plan.deleteIds.includes(r.id))
        .map(r => (reduced.has(r.id) ? { ...r, amount_cents: reduced.get(r.id) } : r));
      // The real charge writes its own row, exactly as policy-fees does.
      kept.push(cardRow({ id: 'tx_new_charge', amount_cents: chargedCents }));
      return kept
        .filter(r => INCOME_TYPES.includes(r.type))
        .reduce((sum, r) => sum + r.amount_cents, 0);
    };

    // The incident: complete, then charge the balance. GBP 45 once, not twice.
    expect(apply([assumedRow()], 4500)).toBe(4500);
    // Part paid on the card, the rest still only assumed.
    expect(apply([assumedRow()], 2000)).toBe(4500);
    // Charged more than the price: the surplus is genuinely hers.
    expect(apply([assumedRow()], 6000)).toBe(6000);
    // Nothing was ever assumed (a booking that never auto-completed).
    expect(apply([], 4500)).toBe(4500);
  });
});

describe('the ledger she reads at tax time', () => {
  it('flags a completion row as assumed and a card charge as not', () => {
    const { rows } = buildLedger({
      transactions: [
        { ...assumedRow(), created_at: '2026-08-27T10:00:00.000Z' },
        { ...cardRow(), created_at: '2026-08-27T11:00:00.000Z' },
      ],
    });
    const byId = Object.fromEntries(rows.map(r => [r.id, r]));
    expect(byId.tx_assumed.assumed).toBe(true);
    expect(byId.tx_card.assumed).toBe(false);
  });

  it('does not call a deposit or a tip an assumption', () => {
    const { rows } = buildLedger({
      transactions: [
        { id: 'tx_dep', type: 'deposit', amount_cents: 1000, payment_method: null, stripe_payment_intent_id: null, created_at: '2026-08-01T10:00:00.000Z' },
        { id: 'tx_tip', type: 'tip', amount_cents: 500, payment_method: null, stripe_payment_intent_id: null, created_at: '2026-08-02T10:00:00.000Z' },
      ],
    });
    expect(rows.every(r => r.assumed === false)).toBe(true);
  });

  it('still adds up to the same running total either way', () => {
    // The flag is a label, not a filter. Hiding assumed money from her totals
    // would be its own lie, and a different one.
    const { summary } = buildLedger({
      transactions: [
        { ...assumedRow(), created_at: '2026-08-27T10:00:00.000Z' },
        { ...cardRow({ id: 'tx_card2', amount_cents: 1000 }), created_at: '2026-08-27T11:00:00.000Z' },
      ],
    });
    expect(summary.income_cents).toBe(5500);
  });
});
