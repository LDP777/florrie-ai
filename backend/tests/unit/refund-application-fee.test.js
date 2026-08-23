/**
 * The platform lost money on every refund it granted.
 *
 * lib/platform-fees.js deliberately makes the application fee TWO things:
 *
 *     application_fee = Florrie's cut + estimated Stripe processing fee
 *
 * because on a destination charge the PLATFORM is the one Stripe bills. That
 * second part is not income, it is a pass-through. The comments in that file
 * exist because leaving it out put the platform balance in arrears.
 *
 * The refund route then set `refund_application_fee: true`, which returns the
 * WHOLE application fee. Stripe does not give its own processing fee back on a
 * UK refund, so Florrie handed back money it never had. On a GBP 10 deposit:
 * 49p collected, 34p of it went straight to Stripe, 15p kept, 49p given back,
 * 34p out of pocket. The same leak, running backwards.
 *
 * The honest number is the RETAINED part only, prorated by how much of the
 * charge is coming back.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import { createServer } from 'node:http';
import { totalApplicationFee, estimateStripeFee, calculatePlatformFee } from '../../src/lib/platform-fees.js';

/* ------------------------------------------------------------- the stripe -- */
const charges = {};
const calls = { refunds: [], appFeeRefunds: [] };
let refundSeq = 0;

const fakeStripe = {
  paymentIntents: {
    retrieve: async (id) => {
      const c = charges[id];
      return { id, amount: c.amount, amount_received: c.amount, latest_charge: c };
    },
  },
  refunds: {
    create: async (params) => {
      calls.refunds.push(params);
      const charge = charges[params.payment_intent];
      const amount = params.amount ?? (charge.amount - charge.amount_refunded);
      charge.amount_refunded += amount;
      return { id: `re_${++refundSeq}`, amount, status: 'succeeded', charge: charge.id };
    },
  },
  applicationFees: {
    createRefund: async (feeId, params) => {
      calls.appFeeRefunds.push({ feeId, amount: params.amount });
      return { id: 'fr_1', amount: params.amount };
    },
  },
};
vi.mock('stripe', () => ({ default: class { constructor() { return fakeStripe; } } }));

/* ----------------------------------------------------------------- the db -- */
const db = { transactions: [], appointments: [] };
function makeBuilder(table) {
  const preds = [];
  let pending = null;
  const rows = () => (db[table] || []).filter(r => preds.every(p => p(r)));
  const settle = () => {
    if (pending) { const hit = rows(); for (const r of hit) Object.assign(r, pending); return { data: hit, error: null }; }
    return { data: rows(), error: null };
  };
  const b = {
    select() { return b; },
    update(p) { pending = p; return b; },
    insert(p) { db[table].push({ ...p }); return b; },
    eq(c, v) { preds.push(r => r[c] === v); return b; },
    maybeSingle() { const s = settle(); return Promise.resolve({ data: s.data?.[0] || null, error: s.error }); },
    single() { const s = settle(); return Promise.resolve({ data: s.data?.[0] || null, error: s.error }); },
    then(res) { return Promise.resolve(settle()).then(res); },
  };
  return b;
}
const supabase = { from: (t) => makeBuilder(t) };

vi.mock('../../src/config.js', () => ({ supabase, supabaseAnon: supabase, supabaseAdmin: supabase }));
vi.mock('../../src/lib/logger.js', () => ({ default: { info() {}, warn() {}, error() {}, debug() {}, fatal() {} } }));
vi.mock('@sentry/node', () => ({ captureMessage() {}, captureException() {}, setUser() {} }));
vi.mock('../../src/middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.beautician = { id: 'biz-1' }; next(); },
}));
vi.mock('../../src/services/notifications.js', () => ({ notifyBookingConfirmed: async () => ({}) }));
vi.mock('../../src/services/push-notifications.js', () => ({ pushBookingConfirmed: async () => {} }));
vi.mock('../../src/services/stripe-cleanup.js', () => ({ cleanupStripeEvents: async () => ({}) }));
vi.mock('../../src/services/policy-fees.js', () => ({ chargePolicyFee: async () => ({}) }));

const { default: stripeRouter, refundableApplicationFeeCents } = await import('../../src/routes/stripe.js');

const app = express();
app.use(express.json());
app.use('/api/stripe', stripeRouter);
const server = createServer(app);
await new Promise(r => server.listen(0, r));
const PORT = server.address().port;
const post = (body) => fetch(`http://127.0.0.1:${PORT}/api/stripe/refund`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

const PI = 'pi_1';
function seed(amount) {
  const fee = totalApplicationFee(amount);
  db.transactions = [{ id: 't1', amount_cents: amount, beautician_id: 'biz-1', appointment_id: 'appt-1', stripe_payment_intent_id: PI }];
  db.appointments = [{ id: 'appt-1', stripe_payment_intent_id: PI, deposit_cents: amount, price_cents: amount, beautician_id: 'biz-1' }];
  charges[PI] = { id: 'ch_1', amount, amount_refunded: 0, application_fee: 'fee_1', application_fee_amount: fee };
  return fee;
}

beforeEach(() => { refundSeq = 0; calls.refunds = []; calls.appFeeRefunds = []; });

/* ========================================================== the arithmetic */
describe('what may honestly be handed back', () => {
  it('the GBP 10 deposit from the platform-fees header comment', () => {
    // 15p Florrie + 34p Stripe = 49p collected, 15p of it kept.
    expect(calculatePlatformFee(1000)).toBe(15);
    expect(estimateStripeFee(1000)).toBe(34);
    expect(totalApplicationFee(1000)).toBe(49);

    expect(refundableApplicationFeeCents({
      chargeAmountCents: 1000, refundAmountCents: 1000, applicationFeeCents: 49,
    })).toBe(15);
  });

  it('Ellie refunding GBP 15 of a GBP 50 deposit', () => {
    // 75p Florrie + 90p Stripe = 165p collected, 75p kept.
    expect(totalApplicationFee(5000)).toBe(165);
    expect(estimateStripeFee(5000)).toBe(90);
    // 75 * 1500/5000 = 22.5 -> 23p. The old behaviour gave back
    // 165 * 1500/5000 = 49.5 -> 50p, so 27p of Florrie's money went with it.
    expect(refundableApplicationFeeCents({
      chargeAmountCents: 5000, refundAmountCents: 1500, applicationFeeCents: 165,
    })).toBe(23);
  });

  it('ten small partials add up to exactly what was retained, never more', () => {
    // Rounding each slice in isolation is how a 5p margin turns into 10p given
    // back. Working from the running total is what stops it.
    for (const amount of [100, 500, 1000, 2500, 5000, 10000, 100000]) {
      const fee = totalApplicationFee(amount);
      const retained = Math.max(0, fee - estimateStripeFee(amount));
      const slice = Math.round(amount / 10);
      let given = 0;
      let already = 0;
      for (let i = 0; i < 10; i++) {
        given += refundableApplicationFeeCents({
          chargeAmountCents: amount,
          refundAmountCents: slice,
          alreadyRefundedCents: already,
          applicationFeeCents: fee,
        });
        already += slice;
      }
      expect(given).toBe(retained);
      expect(refundableApplicationFeeCents({
        chargeAmountCents: amount, refundAmountCents: amount, applicationFeeCents: fee,
      })).toBe(retained);
    }
  });

  it('a second partial only gets the fee the first one did not', () => {
    // GBP 50, retained 75p. GBP 15 back takes 23p, the remaining GBP 35 takes
    // the other 52p, and the two together are exactly 75p.
    const first = refundableApplicationFeeCents({
      chargeAmountCents: 5000, refundAmountCents: 1500, alreadyRefundedCents: 0, applicationFeeCents: 165,
    });
    const second = refundableApplicationFeeCents({
      chargeAmountCents: 5000, refundAmountCents: 3500, alreadyRefundedCents: 1500, applicationFeeCents: 165,
    });
    expect(first).toBe(23);
    expect(second).toBe(52);
    expect(first + second).toBe(75);
  });

  it('gives back nothing on a charge so small that nothing was retained', () => {
    // 10p charge: the fee is capped at the charge amount, 10p, and the Stripe
    // estimate alone is 20p. Florrie kept less than nothing.
    expect(totalApplicationFee(10)).toBe(10);
    expect(refundableApplicationFeeCents({
      chargeAmountCents: 10, refundAmountCents: 10, applicationFeeCents: 10,
    })).toBe(0);
  });

  it('handles nonsense without going negative', () => {
    expect(refundableApplicationFeeCents({ chargeAmountCents: 0, refundAmountCents: 100, applicationFeeCents: 49 })).toBe(0);
    expect(refundableApplicationFeeCents({ chargeAmountCents: 1000, refundAmountCents: 0, applicationFeeCents: 49 })).toBe(0);
    expect(refundableApplicationFeeCents({ chargeAmountCents: 1000, refundAmountCents: 1000, applicationFeeCents: -5 })).toBe(0);
  });

  it('falls back to the fee model when Stripe did not tell us what was charged', () => {
    expect(refundableApplicationFeeCents({
      chargeAmountCents: 1000, refundAmountCents: 1000, applicationFeeCents: undefined,
    })).toBe(15);
  });
});

/* ============================================================== the route */
describe('the refund route', () => {
  it('does not ask Stripe to refund the whole application fee', async () => {
    seed(1000);
    const r = await post({ appointment_id: 'appt-1' });
    expect(r.status).toBe(200);
    expect(calls.refunds[0].refund_application_fee).toBe(false);
  });

  it('gives back Florrie 15p on a full GBP 10 refund, not 49p', async () => {
    seed(1000);
    const r = await post({ appointment_id: 'appt-1' });
    expect(r.status).toBe(200);
    expect(calls.appFeeRefunds).toHaveLength(1);
    expect(calls.appFeeRefunds[0]).toEqual({ feeId: 'fee_1', amount: 15 });
    expect(r.body.application_fee_refunded_cents).toBe(15);
  });

  it('gives back 23p when GBP 15 of a GBP 50 deposit comes back, not 50p', async () => {
    seed(5000);
    const r = await post({ appointment_id: 'appt-1', amount_cents: 1500 });
    expect(r.status).toBe(200);
    expect(calls.appFeeRefunds[0].amount).toBe(23);
    expect(r.body.application_fee_refunded_cents).toBe(23);
  });

  it('still refunds the client in full, the fee change is only Florrie\'s side', async () => {
    seed(5000);
    const r = await post({ appointment_id: 'appt-1' });
    expect(r.body.amount_cents).toBe(5000);
    expect(charges[PI].amount_refunded).toBe(5000);
  });

  it('a refund whose fee refund fails still reports success to the caller', async () => {
    seed(1000);
    const original = fakeStripe.applicationFees.createRefund;
    fakeStripe.applicationFees.createRefund = async () => { throw new Error('fee already refunded'); };
    const r = await post({ appointment_id: 'appt-1' });
    fakeStripe.applicationFees.createRefund = original;
    // The client's money left. Telling Ellie it failed would be a lie.
    expect(r.status).toBe(200);
    expect(charges[PI].amount_refunded).toBe(1000);
  });
});
