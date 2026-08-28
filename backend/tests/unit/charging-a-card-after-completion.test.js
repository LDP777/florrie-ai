/**
 * 27 August 2026, the salon owner to her founder: "How do I charge someone's
 * card on Florrie after it says it's completed?"
 *
 * The answer was that she could not, and the reason was in the books rather
 * than in the button. Completing a booking writes a type 'payment' row so the
 * Money tab counts the day (lib/takings.js). It is an assumption: no card was
 * charged, nobody ticked anything off. chargeRemainingBalance could not tell it
 * from a real payment, so it refused every completed appointment with
 * 'already_charged' for money that had never moved.
 *
 * Opening that door is only safe if the second half holds too. The moment a
 * real charge lands, the guess it replaces has to go, or the same GBP 45 sits
 * in her income twice: once as a guess, once as a fact, and she pays tax on
 * both.
 *
 * So these drive the real services against a Stripe double and a database
 * double, and they assert on what is LEFT IN THE LEDGER afterwards, not on
 * which branch ran.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

/* ------------------------------------------------------------- the stripe -- */
let intentSeq = 0;
const intentsCreated = [];
let stripeBehaviour = 'succeeds';

const fakeStripe = {
  paymentIntents: {
    create: async (params) => {
      intentsCreated.push(params);
      if (stripeBehaviour === 'declines') {
        throw Object.assign(new Error('Your card was declined.'), { type: 'StripeCardError', code: 'card_declined' });
      }
      return { id: `pi_${++intentSeq}`, status: 'succeeded', amount: params.amount };
    },
  },
  paymentMethods: { list: async () => ({ data: [] }) },
};
vi.mock('stripe', () => ({ default: class FakeStripe { constructor() { return fakeStripe; } } }));

/* ----------------------------------------------------------------- the db -- */
const db = { appointments: [], transactions: [] };
// Which write should fail, to prove the service does the safe thing when the
// money table refuses a row. The 'card' CHECK-constraint incident is why.
const failing = { insert: false, read: false, delete: false, update: false };

let txSeq = 0;

function table(name) {
  const filters = [];
  let mode = 'select';
  let payload = null;
  let sort = null;

  const rows = () => (db[name] || []).filter(r => filters.every(f => f(r)));

  function settle() {
    if (mode === 'insert') {
      if (name === 'transactions' && failing.insert) {
        return { data: null, error: { message: 'new row violates check constraint', code: '23514' } };
      }
      const row = { id: `tx_${++txSeq}`, created_at: new Date(2026, 7, 27, 10, txSeq).toISOString(), ...payload };
      db[name].push(row);
      return { data: [row], error: null };
    }
    if (mode === 'delete') {
      if (name === 'transactions' && failing.delete) {
        return { data: null, error: { message: 'delete failed', code: 'XX000' } };
      }
      db[name] = (db[name] || []).filter(r => !filters.every(f => f(r)));
      return { data: null, error: null };
    }
    if (mode === 'update') {
      if (name === 'transactions' && failing.update) {
        return { data: null, error: { message: 'update failed', code: 'XX000' } };
      }
      for (const r of rows()) Object.assign(r, payload);
      return { data: rows(), error: null };
    }
    if (name === 'transactions' && failing.read) {
      return { data: null, error: { message: 'could not read', code: 'XX000' } };
    }
    let out = rows();
    if (sort) {
      out = [...out].sort((a, b) => (a[sort.column] < b[sort.column] ? -1 : a[sort.column] > b[sort.column] ? 1 : 0));
      if (!sort.ascending) out.reverse();
    }
    return { data: out, error: null };
  }

  const b = {
    select() { return b; },
    insert(row) { mode = 'insert'; payload = row; return b; },
    update(patch) { mode = 'update'; payload = patch; return b; },
    delete() { mode = 'delete'; return b; },
    eq(column, value) { filters.push(r => r[column] === value); return b; },
    in(column, values) { const set = new Set(values); filters.push(r => set.has(r[column])); return b; },
    is(column, value) { filters.push(r => (r[column] ?? null) === value); return b; },
    limit() { return b; },
    order(column, opts = {}) { sort = { column, ascending: opts.ascending !== false }; return b; },
    maybeSingle() { const res = settle(); return Promise.resolve({ data: res.error ? null : (res.data || [])[0] || null, error: res.error }); },
    then(resolve, reject) { return Promise.resolve(settle()).then(resolve, reject); },
  };
  return b;
}
vi.mock('../../src/config.js', () => ({ supabase: { from: table } }));

const { chargeRemainingBalance, chargeCardAmount } = await import('../../src/services/policy-fees.js');
const { INCOME_TYPES } = await import('../../src/lib/money-guards.js');

/* -------------------------------------------------------------- her salon -- */
const APPT = 'appt_kayleigh';

/** A GBP 45 brow lamination, finished, with a card on file. */
function bookingFinished({ depositCents = 0 } = {}) {
  db.appointments = [{
    id: APPT,
    beautician_id: 'b1',
    client_id: 'c1',
    status: 'completed',
    price_cents: 4500,
    deposit_cents: depositCents,
    deposit_paid: depositCents > 0,
    payment_type: 'deposit',
    stripe_payment_method_id: 'pm_kayleigh',
    clients: { id: 'c1', first_name: 'Kayleigh', last_name: 'B', stripe_customer_id: 'cus_1' },
    beauticians: { id: 'b1', business_name: 'Ellindigo', first_name: 'Ellie', stripe_account_id: 'acct_1', stripe_onboarding_complete: true },
  }];
}

/** The row completion writes: an assumption, nothing more. */
function completionAssumed(amountCents = 4500) {
  db.transactions.push({
    id: 'tx_assumed',
    created_at: '2026-08-27T09:00:00.000Z',
    beautician_id: 'b1',
    appointment_id: APPT,
    client_id: 'c1',
    amount_cents: amountCents,
    type: 'payment',
    status: 'completed',
    payment_method: null,
    stripe_payment_intent_id: null,
  });
}

/** Everything the Money tab would add up for this booking. */
const incomeForBooking = () => db.transactions
  .filter(t => t.appointment_id === APPT && INCOME_TYPES.includes(t.type))
  .reduce((sum, t) => sum + t.amount_cents, 0);

beforeEach(() => {
  db.appointments = [];
  db.transactions = [];
  intentsCreated.length = 0;
  intentSeq = 0;
  txSeq = 0;
  stripeBehaviour = 'succeeds';
  failing.insert = false;
  failing.read = false;
  failing.delete = false;
  failing.update = false;
});

describe('the question she asked: charging a card after it says completed', () => {
  it('takes the balance from a finished booking that was only ever assumed paid', () => {
    // The old guard saw the assumed row, said 'already_charged', and that was
    // the end of it on every completed appointment she had.
    bookingFinished();
    completionAssumed();
    return chargeRemainingBalance(APPT).then(result => {
      expect(result.charged).toBe(true);
      expect(result.amountCents).toBe(4500);
      expect(intentsCreated).toHaveLength(1);
      expect(intentsCreated[0]).toMatchObject({ amount: 4500, confirm: true, off_session: true });
    });
  });

  it('still refuses when the money really did arrive', async () => {
    bookingFinished();
    db.transactions.push({
      id: 'tx_real', created_at: '2026-08-27T09:00:00.000Z', appointment_id: APPT,
      amount_cents: 4500, type: 'payment', payment_method: 'card_online', stripe_payment_intent_id: 'pi_old',
    });
    const result = await chargeRemainingBalance(APPT);
    expect(result).toEqual({ charged: false, reason: 'already_charged' });
    expect(intentsCreated).toHaveLength(0);
  });

  it('still refuses when she keyed the cash in herself', async () => {
    // No payment intent, but a human said she was paid. That is evidence, and
    // charging over the top of it would take the money twice.
    bookingFinished();
    db.transactions.push({
      id: 'tx_cash', created_at: '2026-08-27T09:00:00.000Z', appointment_id: APPT,
      amount_cents: 4500, type: 'payment', payment_method: 'cash', stripe_payment_intent_id: null,
    });
    const result = await chargeRemainingBalance(APPT);
    expect(result).toEqual({ charged: false, reason: 'already_charged' });
    expect(intentsCreated).toHaveLength(0);
  });

  it('refuses to charge blind when it cannot read the books', async () => {
    bookingFinished();
    failing.read = true;
    const result = await chargeRemainingBalance(APPT);
    expect(result).toEqual({ charged: false, reason: 'guard_unreadable' });
    expect(intentsCreated).toHaveLength(0);
  });
});

describe('her income cannot be counted twice', () => {
  it('records GBP 45 once when a completed booking is charged for GBP 45', async () => {
    bookingFinished();
    completionAssumed();
    expect(incomeForBooking()).toBe(4500);

    await chargeRemainingBalance(APPT);

    // The number that matters. Not 9000.
    expect(incomeForBooking()).toBe(4500);
    const rows = db.transactions.filter(t => t.appointment_id === APPT);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ payment_method: 'card_online', amount_cents: 4500 });
    expect(rows[0].stripe_payment_intent_id).toBeTruthy();
  });

  it('leaves the rest still assumed when she only charges part of it', async () => {
    // Kayleigh pays GBP 20 on the card and swears the other GBP 25 was cash.
    bookingFinished();
    completionAssumed();

    await chargeCardAmount(APPT, 2000, 'Balance');

    expect(incomeForBooking()).toBe(4500);
    const assumed = db.transactions.find(t => t.id === 'tx_assumed');
    expect(assumed.amount_cents).toBe(2500);
    const real = db.transactions.find(t => t.stripe_payment_intent_id);
    expect(real.amount_cents).toBe(2000);
  });

  it('keeps a charge bigger than the booking, and cancels only the guess', async () => {
    // GBP 60 taken on a GBP 45 booking: a top-up, a retail item. The extra
    // GBP 15 is genuinely hers and must survive.
    bookingFinished();
    completionAssumed();

    await chargeCardAmount(APPT, 6000, 'Treatment plus tint');

    expect(incomeForBooking()).toBe(6000);
    expect(db.transactions.find(t => t.id === 'tx_assumed')).toBeUndefined();
  });

  it('leaves a real payment from earlier completely alone', async () => {
    // A deposit is not the price and must not be cancelled by a later charge.
    bookingFinished({ depositCents: 1000 });
    db.transactions.push({
      id: 'tx_deposit', created_at: '2026-08-01T09:00:00.000Z', appointment_id: APPT,
      amount_cents: 1000, type: 'deposit', payment_method: 'card_online', stripe_payment_intent_id: 'pi_deposit',
    });
    completionAssumed(3500);

    await chargeRemainingBalance(APPT);

    expect(db.transactions.find(t => t.id === 'tx_deposit')).toMatchObject({ amount_cents: 1000 });
    // GBP 10 deposit plus GBP 35 balance, and the GBP 35 guess gone.
    expect(incomeForBooking()).toBe(4500);
  });

  it('does not go near the guess when nothing was charged', async () => {
    bookingFinished();
    completionAssumed();
    stripeBehaviour = 'declines';

    const result = await chargeRemainingBalance(APPT);

    expect(result.charged).toBe(false);
    expect(db.transactions.find(t => t.id === 'tx_assumed')).toMatchObject({ amount_cents: 4500 });
    expect(incomeForBooking()).toBe(4500);
  });

  it('keeps the guess when the card was charged but the ledger row was rejected', async () => {
    // The 'card' CHECK-constraint incident: money leaves, the insert fails.
    // Retracting the assumption here would leave her books showing NOTHING for
    // a booking that was both worked and paid. A row that is only assumed beats
    // no row at all, and reconciliation shouts about the mismatch either way.
    bookingFinished();
    completionAssumed();
    failing.insert = true;

    const result = await chargeRemainingBalance(APPT);

    expect(result.charged).toBe(true);
    expect(db.transactions.find(t => t.id === 'tx_assumed')).toMatchObject({ amount_cents: 4500 });
    expect(incomeForBooking()).toBe(4500);
  });

  it('records the charge even if the guess cannot be retracted', async () => {
    // Worse books, but never lost money: the real row is already in, and the
    // failure is logged and captured for a human rather than swallowed.
    bookingFinished();
    completionAssumed();
    failing.delete = true;

    const result = await chargeRemainingBalance(APPT);

    expect(result.charged).toBe(true);
    expect(db.transactions.some(t => t.stripe_payment_intent_id)).toBe(true);
  });
});
