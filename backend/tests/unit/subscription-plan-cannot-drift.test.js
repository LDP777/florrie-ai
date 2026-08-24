/**
 * The silent downgrade.
 *
 * A salon on Florrie for Teams pays for /team, /rota, /locations and
 * /staff-performance. Nobody cancels anything. Then Stripe sends the next
 * customer.subscription.updated (renewal, card update, trial ending) and the
 * webhook writes subscription_plan: 'florrie'. On the next page load the team
 * pages are gone.
 *
 * Two halves of one sentence had drifted apart:
 *   routes/billing.js  wrote  metadata.plan
 *   routes/stripe.js   read   metadata.plan_id   -> undefined, every time
 * and undefined fell through to a hardcoded 'florrie' default.
 *
 * The fix is not "read the right key". It is that there is now ONE key, named
 * once, imported by both sides, and a plan that cannot be read leaves the
 * stored plan alone and shouts. These tests hold that line: the first drives
 * the real webhook with metadata built by the real writer, so renaming the key
 * on either side fails here.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import { createServer } from 'node:http';

process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_plan_drift';

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
const db = { beauticians: [], stripe_events: [] };

function makeBuilder(table) {
  const preds = [];
  let pending = null;
  let inserted = null;
  const rows = () => (db[table] || []).filter(r => preds.every(p => p(r)));
  const settle = () => {
    if (pending) {
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
    eq(c, v) { preds.push(r => r[c] === v); return b; },
    maybeSingle() { const s = settle(); return Promise.resolve({ data: s.data?.[0] || null, error: s.error }); },
    single() { const s = settle(); return Promise.resolve({ data: s.data?.[0] || null, error: s.error }); },
    then(res) { return Promise.resolve(settle()).then(res); },
  };
  return b;
}
const supabase = { from: t => makeBuilder(t) };

const sentryMessages = [];
const loggedErrors = [];

vi.mock('../../src/config.js', () => ({ supabase, supabaseAnon: supabase, supabaseAdmin: supabase }));
vi.mock('../../src/lib/logger.js', () => ({
  default: {
    info() {}, warn() {}, debug() {}, fatal() {},
    error(...args) { loggedErrors.push(args); },
  },
}));
vi.mock('@sentry/node', () => ({
  captureMessage(msg, ctx) { sentryMessages.push({ msg, ctx }); },
  captureException() {},
  setUser() {},
}));
vi.mock('../../src/middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => {
    req.beautician = { id: 'biz-1', email: 'ellie@example.com' };
    next();
  },
}));
vi.mock('../../src/services/notifications.js', () => ({ notifyBookingConfirmed: async () => ({}) }));
vi.mock('../../src/services/push-notifications.js', () => ({ pushBookingConfirmed: async () => {} }));
vi.mock('../../src/services/stripe-cleanup.js', () => ({ cleanupStripeEvents: async () => ({ deleted: 0 }) }));
vi.mock('../../src/services/policy-fees.js', () => ({ chargePolicyFee: async () => ({}) }));

const { default: stripeRouter } = await import('../../src/routes/stripe.js');
const { subscriptionMetadata, readPlanFromMetadata, PLAN_METADATA_KEY } =
  await import('../../src/routes/billing.js');

/* ------------------------------------------------------------- the server -- */
const app = express();
app.use(express.json());
app.use('/api/stripe', stripeRouter);
const server = createServer(app);
await new Promise(r => server.listen(0, r));
const PORT = server.address().port;

let eventSeq = 0;
const sendEvent = (event) => fetch(`http://127.0.0.1:${PORT}/api/stripe/webhook`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=1,v1=fake' },
  body: JSON.stringify({ id: `evt_${++eventSeq}`, ...event }),
}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

const subscriptionUpdated = (metadata) => ({
  type: 'customer.subscription.updated',
  data: {
    object: {
      id: 'sub_team',
      status: 'active',
      current_period_end: 1893456000,
      metadata,
    },
  },
});

const stored = () => db.beauticians.find(b => b.id === 'biz-1');

beforeEach(() => {
  db.beauticians = [{
    id: 'biz-1',
    subscription_plan: 'florrie_team',
    subscription_status: 'active',
    subscription_stripe_id: 'sub_team',
  }];
  db.stripe_events = [];
  sentryMessages.length = 0;
  loggedErrors.length = 0;
});

/* ========================================== the writer and the reader agree */
describe('the plan the checkout writes is the plan the webhook reads', () => {
  it('keeps a Team subscriber on Team through a subscription.updated', async () => {
    const metadata = subscriptionMetadata({
      beauticianId: 'biz-1',
      plan: 'florrie_team',
      interval: 'monthly',
    });

    const r = await sendEvent(subscriptionUpdated(metadata));
    expect(r.status).toBe(200);

    // The bug wrote 'florrie' here and took /team, /rota, /locations and
    // /staff-performance away with it.
    expect(stored().subscription_plan).toBe('florrie_team');
    expect(stored().subscription_status).toBe('active');
  });

  it('still writes the solo plan when that is what was bought', async () => {
    db.beauticians[0].subscription_plan = 'trial';
    const metadata = subscriptionMetadata({ beauticianId: 'biz-1', plan: 'florrie' });

    await sendEvent(subscriptionUpdated(metadata));

    expect(stored().subscription_plan).toBe('florrie');
  });

  it('names the metadata key in one place, and it is the one the writer uses', () => {
    const written = subscriptionMetadata({ beauticianId: 'b', plan: 'florrie_team' });
    expect(Object.keys(written)).toContain(PLAN_METADATA_KEY);
    expect(readPlanFromMetadata(written).plan).toBe('florrie_team');
  });
});

/* ================================== an unreadable plan is loud, not cheaper */
describe('a subscription whose plan cannot be read', () => {
  it('leaves the stored plan alone rather than defaulting to the cheaper one', async () => {
    // Metadata with a beautician but no plan at all: exactly what the old
    // plan_id read saw on every single event.
    await sendEvent(subscriptionUpdated({ beautician_id: 'biz-1' }));

    expect(stored().subscription_plan).toBe('florrie_team');
    // and it still records the parts of the event it DID understand
    expect(stored().subscription_status).toBe('active');
  });

  it('shouts, so a mismatch is noticed instead of being absorbed', async () => {
    await sendEvent(subscriptionUpdated({ beautician_id: 'biz-1' }));

    expect(sentryMessages.map(s => s.msg)).toContain('Subscription webhook could not read the plan');
    expect(loggedErrors.length).toBeGreaterThan(0);
  });

  it('refuses a plan name that is not one we sell', async () => {
    await sendEvent(subscriptionUpdated({ beautician_id: 'biz-1', plan: 'enterprise_platinum' }));

    expect(stored().subscription_plan).toBe('florrie_team');
    expect(sentryMessages.length).toBeGreaterThan(0);
  });
});

/* ================================================== reading the metadata === */
describe('readPlanFromMetadata', () => {
  it('reports what went wrong instead of guessing', () => {
    expect(readPlanFromMetadata(undefined)).toMatchObject({ plan: null, problem: 'missing' });
    expect(readPlanFromMetadata({})).toMatchObject({ plan: null, problem: 'missing' });
    expect(readPlanFromMetadata({ plan: '  ' })).toMatchObject({ plan: null, problem: 'missing' });
    expect(readPlanFromMetadata({ plan: 'starter' })).toMatchObject({ plan: null, problem: 'unknown_plan', found: 'starter' });
  });

  it('accepts a hand-made plan_id but flags it as drift', () => {
    expect(readPlanFromMetadata({ plan_id: 'florrie_team' }))
      .toMatchObject({ plan: 'florrie_team', problem: 'legacy_key' });
  });
});
