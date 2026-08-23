/**
 * A SECOND REFUND SHE MEANT, REPORTED AS A SUCCESS THAT NEVER HAPPENED.
 *
 * The idempotency key on POST /api/stripe/refund is
 * beauticianId:paymentIntentId:amountCents and nothing in the app sends
 * refund_request_id, so it is the only key there is. That is exactly right for
 * a double tap and blind to a decision:
 *
 *   Ellie refunds GBP 15 of Kayleigh's GBP 50 deposit.
 *   An hour later they agree on another GBP 15.
 *   Same beautician, same payment, same amount, same key.
 *
 * Stripe replays the FIRST refund and creates nothing. The ceiling check
 * passed (there was GBP 35 left), so the route answered success:true with the
 * old refund's id and remaining_refundable_cents a further GBP 15 out. No money
 * moved, Kayleigh is GBP 15 short, and the only person who could notice was
 * told it worked.
 *
 * The charge is the witness: if amount_refunded did not move, nothing left the
 * account, whatever the refund object says. The key stays exactly as it is,
 * because the double-tap protection is the point.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import { createServer } from 'node:http';

/* ------------------------------------------------------------- the stripe -- */
const charges = {};
const stripeState = {
  refundsCreated: [],
  refundCalls: [],
  intentReads: 0,
  idempotent: new Map(),
};
let refundSeq = 0;

const fakeStripe = {
  paymentIntents: {
    retrieve: async (id) => {
      stripeState.intentReads += 1;
      const c = charges[id];
      if (!c) throw Object.assign(new Error('No such payment_intent'), { statusCode: 404 });
      // The live charge object, so amount_refunded reads as it does at Stripe.
      return { id, amount: c.amount, amount_received: c.amount, latest_charge: { ...c } };
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
      const refund = {
        id: `re_${++refundSeq}`, amount, status: 'succeeded', charge: charge.id,
        created: Math.floor(Date.now() / 1000),
      };
      stripeState.refundsCreated.push(refund);
      if (key) stripeState.idempotent.set(key, refund);
      return refund;
    },
  },
  applicationFees: { createRefund: async (_id, params) => ({ id: 'fr_1', amount: params.amount }) },
  accounts: { retrieve: async () => ({ id: 'acct_1' }) },
};

vi.mock('stripe', () => ({ default: class { constructor() { return fakeStripe; } } }));

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

const { default: stripeRouter } = await import('../../src/routes/stripe.js');

/* ------------------------------------------------------------- the server -- */
const app = express();
app.use(express.json());
app.use('/api/stripe', stripeRouter);
const server = createServer(app);
await new Promise(r => server.listen(0, r));
const PORT = server.address().port;

const refund = (body) => fetch(`http://127.0.0.1:${PORT}/api/stripe/refund`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', authorization: 'Bearer ellie-token' },
  body: JSON.stringify(body),
}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

const PI = 'pi_kayleigh';

beforeEach(() => {
  refundSeq = 0;
  stripeState.refundsCreated = [];
  stripeState.refundCalls = [];
  stripeState.intentReads = 0;
  stripeState.idempotent.clear();
  db.transactions = [];
  db.appointments = [{
    id: 'appt-1', stripe_payment_intent_id: PI, deposit_cents: 5000, price_cents: 12000,
    beautician_id: 'biz-1', deposit_paid: true, deposit_status: 'paid',
  }];
  charges[PI] = {
    id: 'ch_kayleigh', amount: 5000, amount_refunded: 0,
    application_fee: 'fee_1', application_fee_amount: 165,
  };
});

describe('a replay is not a refund, and must not be reported as one', () => {
  it('does not claim success when Stripe replayed and no money moved', async () => {
    await refund({ appointment_id: 'appt-1', amount_cents: 1500 });
    const second = await refund({ appointment_id: 'appt-1', amount_cents: 1500 });

    expect(charges[PI].amount_refunded, 'this test is not set up right').toBe(1500);
    expect(second.body.success, 'told her a refund went through that did not').toBe(false);
    expect(second.body.duplicate).toBe(true);
  });

  it('gets the money left on the charge right instead of double counting', async () => {
    await refund({ appointment_id: 'appt-1', amount_cents: 1500 });
    const second = await refund({ appointment_id: 'appt-1', amount_cents: 1500 });

    // GBP 50 charge, GBP 15 actually refunded. GBP 35 is left, not GBP 20.
    expect(second.body.remaining_refundable_cents).toBe(3500);
    expect(second.body.already_refunded_cents).toBe(1500);
  });

  it('says how to make it a genuine second refund', async () => {
    await refund({ appointment_id: 'appt-1', amount_cents: 1500 });
    const second = await refund({ appointment_id: 'appt-1', amount_cents: 1500 });

    const said = `${second.body.error || ''} ${second.body.message || ''}`;
    expect(said).toMatch(/refund_request_id/);
  });

  it('still hands back the id of the refund that DID happen', async () => {
    // Two taps of one button is the common case, and the honest answer there
    // is still "here is the refund", not an error.
    const first = await refund({ appointment_id: 'appt-1', amount_cents: 1500 });
    const second = await refund({ appointment_id: 'appt-1', amount_cents: 1500 });

    expect(second.status).toBe(200);
    expect(second.body.refund_id).toBe(first.body.refund_id);
  });

  it('writes no second negative row for money that only left once', async () => {
    await refund({ appointment_id: 'appt-1', amount_cents: 1500 });
    await refund({ appointment_id: 'appt-1', amount_cents: 1500 });

    const out = db.transactions.filter(t => (t.amount_cents || 0) < 0);
    expect(out).toHaveLength(1);
  });

  it('lets the deliberate second refund through when she says it is deliberate', async () => {
    await refund({ appointment_id: 'appt-1', amount_cents: 1500 });
    const deliberate = await refund({
      appointment_id: 'appt-1', amount_cents: 1500, refund_request_id: 'agreed-on-the-phone',
    });

    expect(deliberate.body.success).toBe(true);
    expect(deliberate.body.duplicate).toBeUndefined();
    expect(deliberate.body.refund_id).not.toBe(stripeState.refundsCreated[0].id);
    expect(charges[PI].amount_refunded).toBe(3000);
    expect(deliberate.body.remaining_refundable_cents).toBe(2000);
  });
});

describe('what must not change', () => {
  it('a first, ordinary refund still reports success', async () => {
    const r = await refund({ appointment_id: 'appt-1', amount_cents: 1500 });

    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.duplicate).toBeUndefined();
    expect(r.body.amount_cents).toBe(1500);
    expect(r.body.remaining_refundable_cents).toBe(3500);
  });

  it('a different amount is a different key and goes through as itself', async () => {
    await refund({ appointment_id: 'appt-1', amount_cents: 1500 });
    const other = await refund({ appointment_id: 'appt-1', amount_cents: 500 });

    expect(other.body.success).toBe(true);
    expect(charges[PI].amount_refunded).toBe(2000);
  });

  it('still refuses more than is left on the charge before Stripe is asked', async () => {
    const r = await refund({ appointment_id: 'appt-1', amount_cents: 999999 });
    expect(r.status).toBe(400);
    expect(stripeState.refundCalls).toHaveLength(0);
  });

  it('reports the refund normally when the charge cannot be re-read afterwards', async () => {
    // A verification that fails proves nothing, and must never turn a genuine
    // refund into an error.
    const realRetrieve = fakeStripe.paymentIntents.retrieve;
    let reads = 0;
    fakeStripe.paymentIntents.retrieve = async (id) => {
      reads += 1;
      if (reads > 1) throw new Error('network');
      return realRetrieve(id);
    };
    try {
      const r = await refund({ appointment_id: 'appt-1', amount_cents: 1500 });
      expect(r.status).toBe(200);
      expect(r.body.success).toBe(true);
    } finally {
      fakeStripe.paymentIntents.retrieve = realRetrieve;
    }
  });
});
