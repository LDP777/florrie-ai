/**
 * Writes that decide who pays must not look away from their own result.
 *
 * A Supabase select or update naming a missing column resolves with
 * { data: null, error } and does not throw. Four money-adjacent calls were
 * written as `await supabase...` or `const { data }` alone:
 *
 *   routes/billing.js  create-checkout and create-subscription-intent, saving
 *                      the new stripe_customer_id. A lost write means the
 *                      NEXT checkout creates a SECOND Stripe customer and the
 *                      monthly overage invoice items attach to the orphan.
 *   routes/stripe.js   /subscribe, the same write.
 *   routes/stripe.js   /checkout, the Stripe Connect gate. A read failure
 *                      answered 400 'Beautician has not completed Stripe
 *                      setup', which is a lie about the salon.
 *
 * And the team plan hardcoded quantity: 1 on every checkout line while
 * lib/tiers.js carried a calculateTeamCost nobody called.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

process.env.STRIPE_SECRET_KEY = 'sk_test_money_writes';
process.env.STRIPE_PRICE_FLORRIE = 'price_florrie_monthly';
process.env.STRIPE_PRICE_FLORRIE_TEAM = 'price_team_monthly';
process.env.FRONTEND_URL = 'https://app.florrie.test';

const here = dirname(fileURLToPath(import.meta.url));
const src = (rel) => readFileSync(join(here, '../../src', rel), 'utf8');

/* ------------------------------------------------------------- the stripe -- */
const stripeState = { checkoutSessions: [] };
const fakeStripe = {
  customers: { create: async () => ({ id: 'cus_new' }) },
  checkout: {
    sessions: {
      create: async (params) => {
        stripeState.checkoutSessions.push(params);
        return { id: 'cs_1', url: 'https://checkout.example/cs_1', client_secret: 'cs_secret', payment_intent: 'pi_1' };
      },
    },
  },
  webhooks: { constructEvent: p => (typeof p === 'string' ? JSON.parse(p) : p) },
};
vi.mock('stripe', () => ({
  default: class FakeStripe { constructor() { return fakeStripe; } },
}));

/* ----------------------------------------------------------------- the db -- */
const db = { beauticians: [], plans: [], team_members: [], appointments: [] };
const dbState = { failCustomerIdWrite: false, failBeauticianRead: false };

function makeBuilder(table) {
  const preds = [];
  let pending = null;
  let countMode = false;
  const rows = () => (db[table] || []).filter(r => preds.every(p => p(r)));
  const settle = () => {
    if (table === 'beauticians' && pending && 'stripe_customer_id' in pending && dbState.failCustomerIdWrite) {
      return { data: null, error: { code: '42703', message: 'column beauticians.stripe_customer_id does not exist' } };
    }
    if (table === 'beauticians' && !pending && dbState.failBeauticianRead) {
      return { data: null, error: { code: '42703', message: 'column beauticians.stripe_onboarding_complete does not exist' } };
    }
    if (pending) {
      const hit = rows();
      for (const r of hit) Object.assign(r, pending);
      return { data: hit, error: null };
    }
    if (countMode) return { data: null, error: null, count: rows().length };
    return { data: rows(), error: null };
  };
  const b = {
    select(_c, o) { if (o?.count) countMode = true; return b; },
    update(p) { pending = p; return b; },
    eq(c, v) { preds.push(r => r[c] === v); return b; },
    maybeSingle() { const s = settle(); return Promise.resolve({ data: s.data?.[0] || null, error: s.error }); },
    single() { const s = settle(); return Promise.resolve({ data: s.data?.[0] || null, error: s.error }); },
    then(res) { return Promise.resolve(settle()).then(res); },
  };
  return b;
}
const supabase = { from: t => makeBuilder(t) };

const loggedErrors = [];
let currentBeautician = null;

vi.mock('../../src/config.js', () => ({ supabase, supabaseAnon: supabase, supabaseAdmin: supabase }));
vi.mock('../../src/lib/logger.js', () => ({
  default: { info() {}, warn() {}, debug() {}, fatal() {}, error(...a) { loggedErrors.push(a); } },
}));
vi.mock('@sentry/node', () => ({ captureMessage() {}, captureException() {}, setUser() {} }));
vi.mock('../../src/middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.beautician = currentBeautician; next(); },
}));
vi.mock('../../src/services/notifications.js', () => ({ notifyBookingConfirmed: async () => ({}), sendEmail: async () => ({}) }));
vi.mock('../../src/services/booking-confirmed-alert.js', () => ({ announceBookingConfirmed: async () => ({}) }));
vi.mock('../../src/services/stripe-cleanup.js', () => ({ cleanupStripeEvents: async () => ({ deleted: 0 }) }));
vi.mock('../../src/services/policy-fees.js', () => ({ chargePolicyFee: async () => ({}) }));

const { default: billingRouter } = await import('../../src/routes/billing.js');
const { default: stripeRouter } = await import('../../src/routes/stripe.js');

const app = express();
app.use(express.json());
app.use('/api/billing', billingRouter);
app.use('/api/stripe', stripeRouter);
const server = createServer(app);
await new Promise(r => server.listen(0, r));
const PORT = server.address().port;

const post = (path, body) => fetch(`http://127.0.0.1:${PORT}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', authorization: 'Bearer ellie' },
  body: JSON.stringify(body),
}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

beforeEach(() => {
  stripeState.checkoutSessions = [];
  loggedErrors.length = 0;
  dbState.failCustomerIdWrite = false;
  dbState.failBeauticianRead = false;
  delete process.env.STRIPE_TEAM_PRICE_PER_SEAT;
  currentBeautician = {
    id: 'biz-1', email: 'ellie@example.com', stripe_customer_id: null,
    subscription_plan: 'florrie', subscription_status: 'active',
    trial_ends_at: null, created_at: '2026-01-01T00:00:00Z',
  };
  db.beauticians = [{ id: 'biz-1', stripe_customer_id: null, stripe_account_id: 'acct_1', stripe_onboarding_complete: true, business_name: 'Ellie Lashes' }];
  db.plans = [{ id: 'florrie_team', stripe_price_id: 'price_team_monthly' }, { id: 'florrie', stripe_price_id: 'price_florrie_monthly' }];
  db.team_members = [];
  db.appointments = [{ id: 'appt-1' }];
});

/* ============================================ stripe_customer_id writes === */
describe('saving a new stripe_customer_id', () => {
  it('billing create-checkout: a failed write is logged and the checkout URL is still returned', async () => {
    dbState.failCustomerIdWrite = true;
    const r = await post('/api/billing/create-checkout', { plan: 'florrie' });
    expect(r.status).toBe(200);
    expect(r.body.url).toBe('https://checkout.example/cs_1');
    expect(loggedErrors.some(([ctx, msg]) => /stripe_customer_id/.test(msg) && ctx.stripeCustomerId === 'cus_new')).toBe(true);
  });

  it('billing create-checkout: a successful write is silent', async () => {
    const r = await post('/api/billing/create-checkout', { plan: 'florrie' });
    expect(r.status).toBe(200);
    expect(db.beauticians[0].stripe_customer_id).toBe('cus_new');
    expect(loggedErrors).toHaveLength(0);
  });

  it('stripe /subscribe: a failed write is logged and the checkout URL is still returned', async () => {
    dbState.failCustomerIdWrite = true;
    const r = await post('/api/stripe/subscribe', { plan_id: 'florrie' });
    expect(r.status).toBe(200);
    expect(r.body.url).toBe('https://checkout.example/cs_1');
    expect(loggedErrors.some(([, msg]) => /stripe_customer_id/.test(msg))).toBe(true);
  });

  it('create-subscription-intent destructures the error too (source level)', () => {
    const billing = src('routes/billing.js');
    // Both checkout paths share one helper, and the helper reads its error.
    expect(billing).toMatch(/async function persistStripeCustomerId[\s\S]*?const \{ error \} = await supabase/);
    expect(billing.match(/persistStripeCustomerId\(beautician\.id/g)?.length).toBe(2);
  });
});

/* ================================================= the Connect gate read === */
describe('the Stripe Connect gate on /api/stripe/checkout', () => {
  it('a read failure is a 500 that says so, not a claim the salon has not set up Stripe', async () => {
    dbState.failBeauticianRead = true;
    const r = await post('/api/stripe/checkout', { appointment_id: 'appt-1', beautician_id: 'biz-1', amount_cents: 1000 });
    expect(r.status).toBe(500);
    expect(r.body.error).not.toMatch(/has not completed Stripe setup/);
    expect(loggedErrors.some(([, msg]) => /Connect gate/.test(msg))).toBe(true);
  });

  it('a salon that really has not finished onboarding still gets the 400', async () => {
    db.beauticians[0].stripe_onboarding_complete = false;
    const r = await post('/api/stripe/checkout', { appointment_id: 'appt-1', beautician_id: 'biz-1', amount_cents: 1000 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/has not completed Stripe setup/);
  });
});

/* ========================================================== team seats === */
describe('team seats on the checkout line', () => {
  beforeEach(() => {
    db.team_members = [
      { id: 't1', beautician_id: 'biz-1', is_active: true },
      { id: 't2', beautician_id: 'biz-1', is_active: true },
      { id: 't3', beautician_id: 'biz-1', is_active: false },
      { id: 't4', beautician_id: 'biz-2', is_active: true },
    ];
  });

  it('passes the active staff count as quantity on the team plan once the price is per-seat', async () => {
    process.env.STRIPE_TEAM_PRICE_PER_SEAT = 'true';
    await post('/api/billing/create-checkout', { plan: 'florrie_team' });
    expect(stripeState.checkoutSessions[0].line_items[0]).toEqual({ price: 'price_team_monthly', quantity: 2 });
  });

  it('does the same through /api/stripe/subscribe', async () => {
    process.env.STRIPE_TEAM_PRICE_PER_SEAT = 'true';
    await post('/api/stripe/subscribe', { plan_id: 'florrie_team' });
    expect(stripeState.checkoutSessions[0].line_items[0].quantity).toBe(2);
  });

  it('keeps quantity 1 on the solo plan whatever the staff count', async () => {
    process.env.STRIPE_TEAM_PRICE_PER_SEAT = 'true';
    await post('/api/billing/create-checkout', { plan: 'florrie' });
    expect(stripeState.checkoutSessions[0].line_items[0].quantity).toBe(1);
  });

  it('keeps quantity 1 on the team plan while the Stripe price is still the flat £44', async () => {
    // Stripe multiplies a flat price by the quantity: 2 x £44 is not £29 + £15.
    await post('/api/billing/create-checkout', { plan: 'florrie_team' });
    expect(stripeState.checkoutSessions[0].line_items[0].quantity).toBe(1);
  });

  it('never goes below one seat', async () => {
    process.env.STRIPE_TEAM_PRICE_PER_SEAT = 'true';
    db.team_members = [];
    await post('/api/billing/create-checkout', { plan: 'florrie_team' });
    expect(stripeState.checkoutSessions[0].line_items[0].quantity).toBe(1);
  });
});
