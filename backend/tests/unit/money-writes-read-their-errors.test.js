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
const stripeState = { checkoutSessions: [], accounts: new Map(), accountCreates: [], accountLinks: [], staleAccount: false, customerCreates: [], afterCustomerCreate: null };
const fakeStripe = {
  accounts: {
    retrieve: async () => {
      if (stripeState.staleAccount) throw Object.assign(new Error('No such account'), { statusCode: 404 });
      return { id: 'acct_1' };
    },
    create: async (params, options) => {
      stripeState.accountCreates.push({ params, options });
      const key = options?.idempotencyKey;
      if (!stripeState.accounts.has(key)) stripeState.accounts.set(key, { id: `acct_new_${stripeState.accounts.size + 1}` });
      return stripeState.accounts.get(key);
    },
  },
  accountLinks: { create: async params => { stripeState.accountLinks.push(params); return { url: 'https://connect.stripe.test/onboard' }; } },
  customers: { create: async params => {
    stripeState.customerCreates.push(params);
    stripeState.afterCustomerCreate?.();
    return { id: 'cus_new' };
  } },
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
const db = { beauticians: [], plans: [], team_members: [], appointments: [], clients: [] };
const dbState = { failCustomerIdWrite: false, failClientCustomerIdWrite: false, failBeauticianRead: false, failConnectWrite: false };

function makeBuilder(table) {
  const preds = [];
  let pending = null;
  let countMode = false;
  const rows = () => (db[table] || []).filter(r => preds.every(p => p(r)));
  const settle = () => {
    if (table === 'beauticians' && pending && 'stripe_account_id' in pending && dbState.failConnectWrite) {
      return { data: null, error: { code: 'XX000', message: 'Synthetic failed account save' } };
    }
    if (table === 'beauticians' && pending && 'stripe_customer_id' in pending && dbState.failCustomerIdWrite) {
      return { data: null, error: { code: '42703', message: 'column beauticians.stripe_customer_id does not exist' } };
    }
    if (table === 'clients' && pending && 'stripe_customer_id' in pending && dbState.failClientCustomerIdWrite) {
      return { data: null, error: { code: '08006', message: 'Synthetic customer persistence failure' } };
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
    is(c, v) { preds.push(r => (r[c] ?? null) === v); return b; },
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
  stripeState.accounts.clear();
  stripeState.accountCreates = [];
  stripeState.accountLinks = [];
  stripeState.staleAccount = false;
  stripeState.customerCreates = [];
  stripeState.afterCustomerCreate = null;
  loggedErrors.length = 0;
  dbState.failCustomerIdWrite = false;
  dbState.failClientCustomerIdWrite = false;
  dbState.failConnectWrite = false;
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
  db.appointments = [{ id: 'appt-1', beautician_id: 'biz-1' }];
  db.clients = [];
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

describe('a save-card link requires its customer binding to be saved first', () => {
  beforeEach(() => {
    Object.assign(currentBeautician, { stripe_account_id: 'acct_1', stripe_onboarding_complete: true });
    db.clients = [{ id: 'client-1', beautician_id: 'biz-1', first_name: 'Fictional', stripe_customer_id: null }];
    db.appointments[0].client_id = 'client-1';
    db.appointments[0].clients = db.clients[0];
  });

  it('saves the customer and then creates the normal setup link', async () => {
    expect((await post('/api/stripe/save-card-link', { appointment_id: 'appt-1' })).status).toBe(200);
    expect(db.clients[0].stripe_customer_id).toBe('cus_new');
    expect(stripeState.checkoutSessions).toHaveLength(1);
    expect(stripeState.checkoutSessions[0]).toMatchObject({
      mode: 'setup', customer: 'cus_new',
      metadata: { appointment_id: 'appt-1', beautician_id: 'biz-1', client_id: 'client-1', type: 'save_card' },
    });
  });

  it('does not issue a setup link when the customer write fails, and permits retry', async () => {
    dbState.failClientCustomerIdWrite = true;
    expect((await post('/api/stripe/save-card-link', { appointment_id: 'appt-1' })).status).toBe(500);
    expect(stripeState.checkoutSessions).toEqual([]);
    expect(db.clients[0].stripe_customer_id).toBe(null);
    dbState.failClientCustomerIdWrite = false;
    expect((await post('/api/stripe/save-card-link', { appointment_id: 'appt-1' })).status).toBe(200);
    expect(stripeState.checkoutSessions).toHaveLength(1);
  });

  it('does not replace a customer attached by a competing setup request', async () => {
    stripeState.afterCustomerCreate = () => { db.clients[0].stripe_customer_id = 'cus_concurrent'; };
    expect((await post('/api/stripe/save-card-link', { appointment_id: 'appt-1' })).status).toBe(500);
    expect(db.clients[0].stripe_customer_id).toBe('cus_concurrent');
    expect(stripeState.checkoutSessions).toEqual([]);
    // The next ordinary attempt can reuse the winning customer.
    stripeState.afterCustomerCreate = null;
    expect((await post('/api/stripe/save-card-link', { appointment_id: 'appt-1' })).status).toBe(200);
    expect(stripeState.checkoutSessions[0].customer).toBe('cus_concurrent');
    expect(stripeState.customerCreates).toHaveLength(1);
  });

  it('reuses an existing customer without replacing it', async () => {
    db.clients[0].stripe_customer_id = 'cus_existing';
    expect((await post('/api/stripe/save-card-link', { appointment_id: 'appt-1' })).status).toBe(200);
    expect(stripeState.checkoutSessions[0].customer).toBe('cus_existing');
    expect(stripeState.customerCreates).toEqual([]);
  });

  it('does not issue a link if the client row belongs to a different salon', async () => {
    db.clients[0].beautician_id = 'biz-other';
    expect((await post('/api/stripe/save-card-link', { appointment_id: 'appt-1' })).status).toBe(500);
    expect(stripeState.checkoutSessions).toEqual([]);
    expect(db.clients[0].stripe_customer_id).toBe(null);
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

describe('Stripe Connect setup keeps the account attached to the salon', () => {
  const onboard = () => post('/api/stripe/connect/onboard', {});
  beforeEach(() => {
    currentBeautician.stripe_account_id = null;
    db.beauticians[0].stripe_account_id = null;
  });
  it('saves the new account before returning an onboarding link', async () => {
    expect((await onboard()).status).toBe(200);
    expect(db.beauticians[0].stripe_account_id).toBe('acct_new_1');
    expect(stripeState.accountLinks[0].account).toBe('acct_new_1');
  });
  it('does not open Stripe when account persistence failed, and a retry reuses the provider account', async () => {
    dbState.failConnectWrite = true;
    expect((await onboard()).status).toBe(500);
    expect(stripeState.accountLinks).toHaveLength(0);
    dbState.failConnectWrite = false;
    expect((await onboard()).status).toBe(200);
    expect(stripeState.accountCreates).toHaveLength(2);
    expect(stripeState.accountCreates[0].options.idempotencyKey).toBe(stripeState.accountCreates[1].options.idempotencyKey);
    expect(stripeState.accounts.size).toBe(1);
  });
  it('concurrent first-time requests share one provider account', async () => {
    const result = await Promise.all([onboard(), onboard()]);
    expect(result.map(r => r.status)).toEqual([200, 200]);
    expect(stripeState.accounts.size).toBe(1);
    expect(stripeState.accountLinks.every(link => link.account === db.beauticians[0].stripe_account_id)).toBe(true);
  });
  it('does not overwrite a different connection established after authentication', async () => {
    db.beauticians[0].stripe_account_id = 'acct_other';
    expect((await onboard()).status).toBe(500);
    expect(db.beauticians[0].stripe_account_id).toBe('acct_other');
    expect(stripeState.accountLinks).toHaveLength(0);
  });
  it('does not create another provider account if clearing a stale reference fails', async () => {
    currentBeautician.stripe_account_id = 'acct_old';
    db.beauticians[0].stripe_account_id = 'acct_old';
    stripeState.staleAccount = true;
    dbState.failConnectWrite = true;
    expect((await onboard()).status).toBe(500);
    expect(stripeState.accountCreates).toHaveLength(0);
    expect(db.beauticians[0].stripe_account_id).toBe('acct_old');
  });
  it('uses a different provider retry key for a different salon', async () => {
    expect((await onboard()).status).toBe(200);
    currentBeautician.id = 'biz-2';
    db.beauticians.push({ id: 'biz-2', stripe_account_id: null });
    expect((await onboard()).status).toBe(200);
    expect(stripeState.accounts.size).toBe(2);
  });
  it('reuses an existing connection without creating an account', async () => {
    currentBeautician.stripe_account_id = 'acct_existing';
    db.beauticians[0].stripe_account_id = 'acct_existing';
    expect((await onboard()).status).toBe(200);
    expect(stripeState.accountCreates).toHaveLength(0);
    expect(stripeState.accountLinks[0].account).toBe('acct_existing');
  });
});
