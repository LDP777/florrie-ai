/**
 * The salon whose card died and who kept the product for free.
 *
 * beauticians.subscription_status has a CHECK (migration 001) that allows
 * 'trial', 'active', 'past_due', 'cancelled' and nothing else. Both Stripe
 * webhooks wrote Stripe's own word into it. Stripe says 'canceled' with one
 * L, 'unpaid', 'incomplete', 'incomplete_expired', 'paused'. Every one of
 * those violated the CHECK, PostgREST resolved with { error } instead of
 * throwing, the error was never read, and the row stayed 'active' forever.
 *
 * Three things are held here:
 *   1. the translation table itself, including the rule that an unknown
 *      status fails towards "you owe us" and never towards free access
 *   2. the live webhook, fed 'unpaid' against a database that enforces the
 *      real CHECK, lands on 'cancelled'
 *   3. a write that fails is logged and sent to Sentry, not swallowed
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import { createServer } from 'node:http';

process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_vocab';

/* ------------------------------------------------------------- the stripe -- */
const fakeStripe = {
  webhooks: {
    constructEvent: (payload) =>
      typeof payload === 'string' || Buffer.isBuffer(payload)
        ? JSON.parse(payload.toString())
        : payload,
  },
  paymentIntents: { retrieve: async () => ({ status: 'succeeded' }) },
  customers: { create: async () => ({ id: 'cus_1' }) },
  subscriptions: { create: async () => ({ id: 'sub_1' }) },
};
vi.mock('stripe', () => ({
  default: class FakeStripe { constructor() { return fakeStripe; } },
}));

/* ----------------------------------------------------------------- the db -- */
// The CHECK from 001_initial_schema.sql, enforced the way PostgREST reports
// it: a resolved { data: null, error }, never a throw.
const CHECK_ALLOWED = ['trial', 'active', 'past_due', 'cancelled'];
const db = { beauticians: [], stripe_events: [] };
const dbState = { failNextBeauticianUpdate: null };

function makeBuilder(table) {
  const preds = [];
  let pending = null;
  let inserted = null;
  const rows = () => (db[table] || []).filter(r => preds.every(p => p(r)));
  const settle = () => {
    if (pending) {
      if (table === 'beauticians' && dbState.failNextBeauticianUpdate) {
        const error = dbState.failNextBeauticianUpdate;
        dbState.failNextBeauticianUpdate = null;
        return { data: null, error };
      }
      if (table === 'beauticians' && 'subscription_status' in pending
          && !CHECK_ALLOWED.includes(pending.subscription_status)) {
        return {
          data: null,
          error: {
            code: '23514',
            message: 'new row for relation "beauticians" violates check constraint "beauticians_subscription_status_check"',
          },
        };
      }
      const hit = rows();
      for (const r of hit) Object.assign(r, pending);
      return { data: hit, error: null };
    }
    if (inserted) return { data: [inserted], error: null };
    return { data: rows(), error: null };
  };
  const b = {
    select() { return b; },
    update(p) { pending = p; return b; },
    insert(p) { inserted = { ...p }; db[table].push(inserted); return b; },
    eq(c, v) { preds.push(r => (c === 'data->billing_claim->>token' ? r.data?.billing_claim?.token : r[c]) === v); return b; },
    is(c, v) { return b.eq(c, v); },
    maybeSingle() { const s = settle(); return Promise.resolve({ data: s.data?.[0] || null, error: s.error }); },
    single() { const s = settle(); return Promise.resolve({ data: s.data?.[0] || null, error: s.error }); },
    then(res) { return Promise.resolve(settle()).then(res); },
  };
  return b;
}
const supabase = { from: t => makeBuilder(t) };

const sentryMessages = [];
const sentryExceptions = [];
const loggedErrors = [];
const loggedWarnings = [];

vi.mock('../../src/config.js', () => ({ supabase, supabaseAnon: supabase, supabaseAdmin: supabase }));
vi.mock('../../src/lib/logger.js', () => ({
  default: {
    info() {}, debug() {}, fatal() {},
    warn(...args) { loggedWarnings.push(args); },
    error(...args) { loggedErrors.push(args); },
  },
}));
vi.mock('@sentry/node', () => ({
  captureMessage(msg, ctx) { sentryMessages.push({ msg, ctx }); },
  captureException(err, ctx) { sentryExceptions.push({ err, ctx }); },
  setUser() {},
}));
vi.mock('../../src/middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => {
    req.beautician = { id: 'biz-1', email: 'ellie@example.com' };
    next();
  },
}));
vi.mock('../../src/services/notifications.js', () => ({
  notifyBookingConfirmed: async () => ({}),
  sendEmail: async () => ({ id: 'email_1' }),
}));
vi.mock('../../src/services/push-notifications.js', () => ({ pushBookingConfirmed: async () => {} }));
vi.mock('../../src/services/stripe-cleanup.js', () => ({ cleanupStripeEvents: async () => ({ deleted: 0 }) }));
vi.mock('../../src/services/policy-fees.js', () => ({ chargePolicyFee: async () => ({}) }));

const { default: stripeRouter } = await import('../../src/routes/stripe.js');
const { default: billingRouter, subscriptionMetadata } = await import('../../src/routes/billing.js');
const { internalStatusFor, INTERNAL_STATUSES } = await import('../../src/lib/subscription-status.js');

/* ------------------------------------------------------------- the server -- */
const app = express();
app.use(express.json());
app.use('/api/stripe', stripeRouter);
app.use('/api/billing', billingRouter);
const server = createServer(app);
await new Promise(r => server.listen(0, r));
const PORT = server.address().port;

let eventSeq = 0;
const sendEvent = (event, path = '/api/stripe/webhook') => fetch(`http://127.0.0.1:${PORT}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=1,v1=fake' },
  body: JSON.stringify({ id: `evt_${++eventSeq}`, ...event }),
}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

const subscriptionUpdated = (status, metadata = subscriptionMetadata({ beauticianId: 'biz-1', plan: 'florrie' })) => ({
  type: 'customer.subscription.updated',
  data: { object: { id: 'sub_1', status, current_period_end: 1893456000, metadata } },
});

const stored = () => db.beauticians.find(b => b.id === 'biz-1');

beforeEach(() => {
  db.beauticians = [{
    id: 'biz-1',
    subscription_plan: 'florrie',
    subscription_status: 'active',
    subscription_stripe_id: 'sub_1',
  }];
  db.stripe_events = [];
  dbState.failNextBeauticianUpdate = null;
  sentryMessages.length = 0;
  sentryExceptions.length = 0;
  loggedErrors.length = 0;
  loggedWarnings.length = 0;
});

/* ============================================================ the table === */
describe('internalStatusFor: Stripe words to Florrie words', () => {
  it.each([
    ['active', 'active'],
    ['trialing', 'active'],
    ['past_due', 'past_due'],
    ['incomplete', 'past_due'],
    ['paused', 'past_due'],
    ['canceled', 'cancelled'],
    ['cancelled', 'cancelled'],
    ['unpaid', 'cancelled'],
    ['incomplete_expired', 'cancelled'],
  ])('%s -> %s', (stripeStatus, internal) => {
    expect(internalStatusFor(stripeStatus)).toBe(internal);
  });

  it('never answers a word the CHECK would reject', () => {
    for (const s of ['active', 'trialing', 'past_due', 'incomplete', 'paused', 'canceled', 'unpaid', 'incomplete_expired', 'something_new', '', undefined, null]) {
      expect(INTERNAL_STATUSES).toContain(internalStatusFor(s));
    }
  });

  it('an unknown status fails towards "you owe us", with a warning, never towards active', () => {
    expect(internalStatusFor('something_stripe_invents_in_2027')).toBe('past_due');
    expect(internalStatusFor(undefined)).toBe('past_due');
    expect(loggedWarnings.length).toBeGreaterThan(0);
  });

  it('is not fooled by case or whitespace', () => {
    expect(internalStatusFor(' Canceled ')).toBe('cancelled');
  });
});

/* ===================================================== the live webhook === */
describe('customer.subscription.updated against the real CHECK', () => {
  it("'unpaid' lands as 'cancelled' instead of failing and leaving the row active", async () => {
    const r = await sendEvent(subscriptionUpdated('unpaid'));
    expect(r.status).toBe(200);
    expect(stored().subscription_status).toBe('cancelled');
    expect(loggedErrors).toHaveLength(0);
  });

  it("'canceled' (one L) lands as 'cancelled'", async () => {
    await sendEvent(subscriptionUpdated('canceled'));
    expect(stored().subscription_status).toBe('cancelled');
  });

  it("'past_due' is written as past_due, not left active", async () => {
    await sendEvent(subscriptionUpdated('past_due'));
    expect(stored().subscription_status).toBe('past_due');
  });

  it('the same mapping holds on /api/billing/webhook', async () => {
    await sendEvent(subscriptionUpdated('unpaid'), '/api/billing/webhook');
    expect(stored().subscription_status).toBe('cancelled');
  });

  it('customer.subscription.deleted writes cancelled and keeps the plan name', async () => {
    // The plan stays so the app can tell "your plan ended" from "your trial
    // ended". Resetting it to 'trial' made an ex-subscriber read as a
    // trialist who never paid.
    const before = stored().subscription_plan;
    await sendEvent({
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_1', status: 'canceled', metadata: { beautician_id: 'biz-1' } } },
    });
    expect(stored().subscription_status).toBe('cancelled');
    expect(stored().subscription_plan).toBe(before);
    expect(stored().subscription_stripe_id).toBeNull();
  });

  it('deleting a subscription that is not the one on file changes nothing', async () => {
    stored().subscription_stripe_id = 'sub_current';
    stored().subscription_status = 'active';
    await sendEvent({
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_old_draft', status: 'canceled', metadata: { beautician_id: 'biz-1' } } },
    });
    expect(stored().subscription_status).toBe('active');
    expect(stored().subscription_stripe_id).toBe('sub_current');
  });

  it('a card form that was opened and never finished does not make the account active', async () => {
    stored().subscription_status = 'trial';
    stored().subscription_plan = 'trial';
    stored().subscription_stripe_id = null;
    await sendEvent({
      type: 'customer.subscription.created',
      data: { object: { id: 'sub_draft', status: 'trialing', default_payment_method: null,
        trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
        metadata: { beautician_id: 'biz-1', plan: 'florrie_team' } } },
    });
    expect(stored().subscription_status).toBe('trial');
    expect(stored().subscription_plan).toBe('trial');
    expect(stored().subscription_stripe_id).toBeNull();
  });
});

/* ===================================================== a failing write === */
describe('a subscription_status write that fails', () => {
  it('is logged at error level and sent to Sentry, not swallowed', async () => {
    dbState.failNextBeauticianUpdate = { code: '42703', message: 'column beauticians.subscription_current_period_end does not exist' };

    const r = await sendEvent(subscriptionUpdated('past_due'));
    expect(r.status).toBe(503);

    // The row is unchanged, which is exactly why somebody has to hear about it.
    expect(stored().subscription_status).toBe('active');
    expect(loggedErrors.some(([, msg]) => /Subscription status update failed/.test(msg))).toBe(true);
    expect(sentryExceptions.length).toBe(1);
    expect(sentryExceptions[0].ctx.extra.beauticianId).toBe('biz-1');
  });

  it('on /api/billing/webhook is logged too', async () => {
    dbState.failNextBeauticianUpdate = { code: '42703', message: 'column does not exist' };
    await sendEvent(subscriptionUpdated('past_due'), '/api/billing/webhook');
    expect(stored().subscription_status).toBe('active');
    expect(loggedErrors.some(([, msg]) => /Subscription status update failed/.test(msg))).toBe(true);
  });
});
