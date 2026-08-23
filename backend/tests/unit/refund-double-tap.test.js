/**
 * Ellie refunds GBP 15 of Kayleigh's GBP 50 deposit. The button does not
 * visibly respond. She taps it again. GBP 30 leaves the account, and because
 * the ledger dedupes, her books say 15.
 *
 * Two separate things had to be wrong for that to happen:
 *
 *   1. POST /api/stripe/refund passed no idempotencyKey to Stripe, and Stripe
 *      will keep creating partial refunds until the charge total is used up.
 *   2. idempotencyGuard only fired on an Idempotency-Key header, and nothing
 *      in the Florrie app has ever sent one.
 *
 * And the amount went through unbounded: no ceiling, so a slipped digit could
 * refund more than was taken, and no floor, so `amount_cents: 0` fell through
 * the `if (amount_cents && ...)` test and refunded the LOT.
 *
 * These drive the real route over real HTTP against a Stripe double that
 * behaves like Stripe: it honours idempotency keys, and without one it makes a
 * brand new refund every time.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import { createServer } from 'node:http';

/* ------------------------------------------------------------- the stripe -- */
// Charge fixtures, keyed by PaymentIntent id.
const charges = {};

const stripeState = {
  refundsCreated: [],        // every refund object that really got made
  refundCalls: [],           // [params, options] for each create() call
  appFeeRefunds: [],         // [feeId, params, options]
  idempotent: new Map(),     // idempotencyKey -> replayed response
};

let refundSeq = 0;

const fakeStripe = {
  paymentIntents: {
    retrieve: async (id) => {
      const c = charges[id];
      if (!c) throw Object.assign(new Error('No such payment_intent'), { statusCode: 404 });
      return { id, amount: c.amount, amount_received: c.amount, latest_charge: c };
    },
  },
  refunds: {
    create: async (params, options = {}) => {
      stripeState.refundCalls.push([params, options]);
      const key = options.idempotencyKey;
      if (key && stripeState.idempotent.has(key)) {
        // Stripe replays the ORIGINAL response and creates nothing new.
        return stripeState.idempotent.get(key);
      }
      const charge = charges[params.payment_intent];
      const amount = params.amount ?? (charge.amount - charge.amount_refunded);
      if (amount > charge.amount - charge.amount_refunded) {
        throw Object.assign(new Error('Refund amount exceeds charge'), { statusCode: 400 });
      }
      charge.amount_refunded += amount;
      const refund = { id: `re_${++refundSeq}`, amount, status: 'succeeded', charge: charge.id };
      stripeState.refundsCreated.push(refund);
      if (key) stripeState.idempotent.set(key, refund);
      return refund;
    },
  },
  applicationFees: {
    createRefund: async (feeId, params, options = {}) => {
      stripeState.appFeeRefunds.push([feeId, params, options]);
      return { id: `fr_${stripeState.appFeeRefunds.length}`, amount: params.amount };
    },
  },
  accounts: { retrieve: async () => ({ id: 'acct_1' }) },
};

vi.mock('stripe', () => ({
  default: class FakeStripe { constructor() { return fakeStripe; } },
}));

/* ----------------------------------------------------------------- the db -- */
const db = { transactions: [], appointments: [] };

function makeBuilder(table) {
  const preds = [];
  let pending = null;
  const rows = () => (db[table] || []).filter(r => preds.every(p => p(r)));
  const settle = () => {
    if (pending) {
      const hit = rows();
      for (const r of hit) Object.assign(r, pending);
      return { data: hit, error: null };
    }
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
  requireAuth: (req, _res, next) => {
    req.beautician = { id: 'biz-1', stripe_account_id: 'acct_1', stripe_onboarding_complete: true };
    next();
  },
}));
vi.mock('../../src/services/notifications.js', () => ({ notifyBookingConfirmed: async () => ({}) }));
vi.mock('../../src/services/push-notifications.js', () => ({ pushBookingConfirmed: async () => {} }));
vi.mock('../../src/services/stripe-cleanup.js', () => ({ cleanupStripeEvents: async () => ({ deleted: 0 }) }));
vi.mock('../../src/services/policy-fees.js', () => ({ chargePolicyFee: async () => ({}) }));

const { default: stripeRouter, refundableApplicationFeeCents, refundIdempotencyKey } =
  await import('../../src/routes/stripe.js');
const { idempotencyGuard, resetIdempotencyKeys } = await import('../../src/middleware/security.js');

/* ------------------------------------------------------------- the servers -- */
// Bare: the route on its own, so what Stripe is asked for is visible.
const bare = express();
bare.use(express.json());
bare.use('/api/stripe', stripeRouter);

// Guarded: how index.js actually mounts it.
const guarded = express();
guarded.use(express.json());
guarded.use('/api/stripe', idempotencyGuard, stripeRouter);

async function listen(app) {
  const server = createServer(app);
  await new Promise(r => server.listen(0, r));
  return server.address().port;
}
const BARE_PORT = await listen(bare);
const GUARDED_PORT = await listen(guarded);

const post = (port, path, body) => fetch(`http://127.0.0.1:${port}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', authorization: 'Bearer ellie-token' },
  body: JSON.stringify(body),
}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

/* --------------------------------------------------------------- fixtures -- */
// Kayleigh's GBP 50 deposit. application_fee = 75p Florrie + 90p Stripe est.
const PI = 'pi_kayleigh';

function seed({ amount = 5000, applicationFee = 165, refunded = 0 } = {}) {
  db.transactions = [{
    id: 'txn-1',
    amount_cents: amount,
    description: 'Deposit',
    beautician_id: 'biz-1',
    appointment_id: 'appt-1',
    client_id: 'kayleigh',
    stripe_payment_intent_id: PI,
  }];
  db.appointments = [{
    id: 'appt-1',
    stripe_payment_intent_id: PI,
    deposit_cents: amount,
    price_cents: 12000,
    beautician_id: 'biz-1',
    deposit_paid: true,
    deposit_status: 'paid',
  }];
  charges[PI] = {
    id: 'ch_kayleigh',
    amount,
    amount_refunded: refunded,
    application_fee: 'fee_1',
    application_fee_amount: applicationFee,
  };
}

beforeEach(() => {
  refundSeq = 0;
  stripeState.refundsCreated = [];
  stripeState.refundCalls = [];
  stripeState.appFeeRefunds = [];
  stripeState.idempotent.clear();
  resetIdempotencyKeys();
  seed();
});

/* ============================================================ the double tap */
describe('a second tap must not be a second refund', () => {
  it('sends Stripe an idempotency key derived from the refund itself', async () => {
    const r = await post(BARE_PORT, '/api/stripe/refund', { appointment_id: 'appt-1', amount_cents: 1500 });
    expect(r.status).toBe(200);

    const [, options] = stripeState.refundCalls[0];
    expect(options.idempotencyKey).toBeTruthy();
    // It has to be derived from THIS refund, not from a random per-request
    // value and not from a header the app never sends.
    expect(options.idempotencyKey).toContain(PI);
    expect(options.idempotencyKey).toContain('1500');
  });

  it('two identical requests take the money once, even with no guard in front', async () => {
    const first = await post(BARE_PORT, '/api/stripe/refund', { appointment_id: 'appt-1', amount_cents: 1500 });
    const second = await post(BARE_PORT, '/api/stripe/refund', { appointment_id: 'appt-1', amount_cents: 1500 });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // Stripe was asked twice and created ONE refund.
    expect(stripeState.refundCalls).toHaveLength(2);
    expect(stripeState.refundsCreated).toHaveLength(1);
    expect(charges[PI].amount_refunded).toBe(1500);
    expect(second.body.refund_id).toBe(first.body.refund_id);
  });

  it('the books get one negative row, not two', async () => {
    await post(BARE_PORT, '/api/stripe/refund', { appointment_id: 'appt-1', amount_cents: 1500 });
    await post(BARE_PORT, '/api/stripe/refund', { appointment_id: 'appt-1', amount_cents: 1500 });

    const out = db.transactions.filter(t => (t.amount_cents || 0) < 0);
    expect(out).toHaveLength(1);
    expect(out[0].amount_cents).toBe(-1500);
  });

  it('the mounted guard turns the second tap away before it reaches Stripe', async () => {
    const first = await post(GUARDED_PORT, '/api/stripe/refund', { appointment_id: 'appt-1', amount_cents: 1500 });
    const second = await post(GUARDED_PORT, '/api/stripe/refund', { appointment_id: 'appt-1', amount_cents: 1500 });

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(stripeState.refundCalls).toHaveLength(1);
  });

  it('a DIFFERENT amount on the same payment still goes through', async () => {
    const a = await post(GUARDED_PORT, '/api/stripe/refund', { appointment_id: 'appt-1', amount_cents: 1500 });
    const b = await post(GUARDED_PORT, '/api/stripe/refund', { appointment_id: 'appt-1', amount_cents: 500 });

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(stripeState.refundsCreated).toHaveLength(2);
    expect(charges[PI].amount_refunded).toBe(2000);
  });

  it('a refund_request_id makes a deliberate repeat distinct', async () => {
    const a = await post(BARE_PORT, '/api/stripe/refund', { appointment_id: 'appt-1', amount_cents: 1500, refund_request_id: 'one' });
    const b = await post(BARE_PORT, '/api/stripe/refund', { appointment_id: 'appt-1', amount_cents: 1500, refund_request_id: 'two' });

    expect(a.body.refund_id).not.toBe(b.body.refund_id);
    expect(charges[PI].amount_refunded).toBe(3000);
  });

  it('a first attempt that failed does not lock the guard for five minutes', async () => {
    // Over the ceiling, so it 400s. The retry with a sane number must work.
    const bad = await post(GUARDED_PORT, '/api/stripe/refund', { appointment_id: 'appt-1', amount_cents: 999999 });
    expect(bad.status).toBe(400);
    const retry = await post(GUARDED_PORT, '/api/stripe/refund', { appointment_id: 'appt-1', amount_cents: 999999 });
    // Same refusal, not a 409 that hides it.
    expect(retry.status).toBe(400);
  });
});

/* ============================================================= the amount box */
describe('the amount box has a floor and a ceiling', () => {
  it('refuses more than is left on the charge', async () => {
    const r = await post(BARE_PORT, '/api/stripe/refund', { appointment_id: 'appt-1', amount_cents: 999999 });
    expect(r.status).toBe(400);
    expect(r.body.max_refundable_cents).toBe(5000);
    expect(stripeState.refundCalls).toHaveLength(0);
  });

  it('refuses more than is LEFT after an earlier partial refund', async () => {
    seed({ refunded: 4000 });
    const r = await post(BARE_PORT, '/api/stripe/refund', { appointment_id: 'appt-1', amount_cents: 1500 });
    expect(r.status).toBe(400);
    expect(r.body.max_refundable_cents).toBe(1000);
    expect(stripeState.refundCalls).toHaveLength(0);
  });

  it('refuses zero instead of quietly refunding everything', async () => {
    // `if (amount_cents && amount_cents > 0)` treated 0 as "not specified",
    // which meant a full refund. Ellie types 0, GBP 50 goes back.
    const r = await post(BARE_PORT, '/api/stripe/refund', { appointment_id: 'appt-1', amount_cents: 0 });
    expect(r.status).toBe(400);
    expect(charges[PI].amount_refunded).toBe(0);
  });

  it('refuses a negative amount instead of quietly refunding everything', async () => {
    const r = await post(BARE_PORT, '/api/stripe/refund', { appointment_id: 'appt-1', amount_cents: -1500 });
    expect(r.status).toBe(400);
    expect(charges[PI].amount_refunded).toBe(0);
  });

  it('refuses pounds typed into a pence box only when they are not whole pence', async () => {
    const r = await post(BARE_PORT, '/api/stripe/refund', { appointment_id: 'appt-1', amount_cents: 15.5 });
    expect(r.status).toBe(400);
    expect(charges[PI].amount_refunded).toBe(0);
  });

  it('refuses a charge that is already fully refunded', async () => {
    seed({ refunded: 5000 });
    const r = await post(BARE_PORT, '/api/stripe/refund', { appointment_id: 'appt-1' });
    expect(r.status).toBe(400);
    expect(stripeState.refundCalls).toHaveLength(0);
  });

  it('no amount still means refund what is left', async () => {
    seed({ refunded: 1000 });
    const r = await post(BARE_PORT, '/api/stripe/refund', { appointment_id: 'appt-1' });
    expect(r.status).toBe(200);
    expect(r.body.amount_cents).toBe(4000);
    expect(r.body.remaining_refundable_cents).toBe(0);
  });
});

/* =============================================== what refundIdempotencyKey is */
describe('refundIdempotencyKey', () => {
  it('is the same for the same intent and different for anything else', () => {
    const base = { beauticianId: 'biz-1', paymentIntentId: PI, amountCents: 1500 };
    expect(refundIdempotencyKey(base)).toBe(refundIdempotencyKey({ ...base }));
    expect(refundIdempotencyKey({ ...base, amountCents: 1501 })).not.toBe(refundIdempotencyKey(base));
    expect(refundIdempotencyKey({ ...base, paymentIntentId: 'pi_other' })).not.toBe(refundIdempotencyKey(base));
    expect(refundIdempotencyKey({ ...base, beauticianId: 'biz-2' })).not.toBe(refundIdempotencyKey(base));
    expect(refundIdempotencyKey({ ...base, requestId: 'redo' })).not.toBe(refundIdempotencyKey(base));
  });
});
