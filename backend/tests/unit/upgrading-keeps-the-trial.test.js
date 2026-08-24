/**
 * Upgrading on day 3 must not cost you the other 11 days.
 *
 * Onboarding creates the subscription through /create-checkout with trial:true,
 * so those accounts get their 14 days. The pricing page goes through
 * /create-subscription-intent, which created the subscription with no trial at
 * all: tap "Upgrade" on day 3 of the trial and Stripe took £29 that minute and
 * the 11 remaining free days simply vanished. The customer who liked the
 * product enough to pay early was the one who got punished for it.
 *
 * The trial belongs to the ACCOUNT (beauticians.trial_ends_at), not to the
 * checkout screen you happen to have open, so both doors now read it from the
 * same place. With a trial there is no invoice to pay, so Stripe raises a
 * SetupIntent instead of a PaymentIntent, and the response has to say which
 * one the card form should confirm.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import { createServer } from 'node:http';

process.env.STRIPE_PRICE_FLORRIE = 'price_florrie_monthly';
process.env.STRIPE_PRICE_FLORRIE_TEAM = 'price_team_monthly';
process.env.STRIPE_PRICE_FLORRIE_ANNUAL = 'price_florrie_annual';
process.env.STRIPE_PRICE_FLORRIE_TEAM_ANNUAL = 'price_team_annual';

const DAY = 86400000;

/* ------------------------------------------------------------- the stripe -- */
const stripeState = { subscriptionsCreated: [], checkoutSessions: [] };

const fakeStripe = {
  customers: { create: async () => ({ id: 'cus_new' }) },
  subscriptions: {
    create: async (params) => {
      stripeState.subscriptionsCreated.push(params);
      const trialDays = params.trial_period_days;
      if (trialDays) {
        // Stripe raises no invoice for a £0 first period, so there is no
        // PaymentIntent to confirm, only a pending SetupIntent for the card.
        return {
          id: 'sub_trialing',
          status: 'trialing',
          trial_end: Math.floor((Date.now() + trialDays * DAY) / 1000),
          latest_invoice: null,
          pending_setup_intent: { id: 'seti_1', client_secret: 'seti_1_secret' },
        };
      }
      return {
        id: 'sub_incomplete',
        status: 'incomplete',
        latest_invoice: { id: 'in_1', payment_intent: { id: 'pi_1', client_secret: 'pi_1_secret' } },
        pending_setup_intent: null,
      };
    },
  },
  checkout: {
    sessions: {
      create: async (params) => {
        stripeState.checkoutSessions.push(params);
        return { id: 'cs_1', url: 'https://checkout.example/cs_1', client_secret: 'cs_1_secret' };
      },
    },
  },
  billingPortal: { sessions: { create: async () => ({ url: 'https://portal' }) } },
  webhooks: { constructEvent: p => (typeof p === 'string' ? JSON.parse(p) : p) },
};

vi.mock('stripe', () => ({
  default: class FakeStripe { constructor() { return fakeStripe; } },
}));

/* ----------------------------------------------------------------- the db -- */
const db = { beauticians: [] };
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
    then(res) { return Promise.resolve(settle()).then(res); },
  };
  return b;
}
const supabase = { from: t => makeBuilder(t) };

// The account the request is made by. Swapped per test.
let currentBeautician = null;

vi.mock('../../src/config.js', () => ({ supabase, supabaseAnon: supabase, supabaseAdmin: supabase }));
vi.mock('../../src/lib/logger.js', () => ({
  default: { info() {}, warn() {}, error() {}, debug() {}, fatal() {} },
}));
vi.mock('../../src/middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.beautician = currentBeautician; next(); },
}));

const { default: billingRouter, remainingTrialDays, TRIAL_DAYS } =
  await import('../../src/routes/billing.js');

/* ------------------------------------------------------------- the server -- */
const app = express();
app.use(express.json());
app.use('/api/billing', billingRouter);
const server = createServer(app);
await new Promise(r => server.listen(0, r));
const PORT = server.address().port;

const post = (path, body) => fetch(`http://127.0.0.1:${PORT}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', authorization: 'Bearer ellie' },
  body: JSON.stringify(body),
}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

/** An account that signed up `daysAgo` days ago, still on its 14 day trial. */
function onTrial(daysAgo) {
  return {
    id: 'biz-1',
    email: 'ellie@example.com',
    stripe_customer_id: 'cus_ellie',
    subscription_plan: 'trial',
    subscription_status: null,
    trial_ends_at: new Date(Date.now() + (TRIAL_DAYS - daysAgo) * DAY).toISOString(),
  };
}

beforeEach(() => {
  stripeState.subscriptionsCreated = [];
  stripeState.checkoutSessions = [];
  db.beauticians = [{ id: 'biz-1' }];
  currentBeautician = onTrial(3);
});

/* ================================================ upgrading from /pricing = */
describe('upgrading from the pricing page on day 3 of the trial', () => {
  it('carries the remaining 11 days onto the subscription', async () => {
    const r = await post('/api/billing/create-subscription-intent', { plan: 'florrie', interval: 'monthly' });

    expect(r.status).toBe(200);
    const [params] = stripeState.subscriptionsCreated;
    // The bug: this key was absent, so the card was charged £29 immediately.
    expect(params.trial_period_days).toBe(11);
    expect(r.body.trialDays).toBe(11);
  });

  it('hands the card form a SetupIntent, because a trial has nothing to pay yet', async () => {
    const r = await post('/api/billing/create-subscription-intent', { plan: 'florrie', interval: 'monthly' });

    expect(r.body.mode).toBe('setup');
    expect(r.body.clientSecret).toBe('seti_1_secret');
    expect(r.body.trialEndsAt).toBeTruthy();
  });

  it('cancels rather than going past_due if no card is on file when the trial ends', async () => {
    await post('/api/billing/create-subscription-intent', { plan: 'florrie', interval: 'monthly' });

    const [params] = stripeState.subscriptionsCreated;
    expect(params.trial_settings?.end_behavior?.missing_payment_method).toBe('cancel');
  });

  it('tags the subscription with the plan under the canonical key', async () => {
    await post('/api/billing/create-subscription-intent', { plan: 'florrie_team', interval: 'monthly' });

    const [params] = stripeState.subscriptionsCreated;
    expect(params.metadata.plan).toBe('florrie_team');
    expect(params.metadata.beautician_id).toBe('biz-1');
  });
});

describe('upgrading when there is no trial left to honour', () => {
  it('charges now for an expired trial, and confirms a PaymentIntent', async () => {
    currentBeautician = { ...onTrial(3), trial_ends_at: new Date(Date.now() - 2 * DAY).toISOString() };

    const r = await post('/api/billing/create-subscription-intent', { plan: 'florrie', interval: 'monthly' });

    expect(stripeState.subscriptionsCreated[0].trial_period_days).toBeUndefined();
    expect(r.body.mode).toBe('payment');
    expect(r.body.clientSecret).toBe('pi_1_secret');
    expect(r.body.trialDays).toBe(0);
  });

  it('gives no second trial to somebody already paying who moves up to Team', async () => {
    currentBeautician = {
      id: 'biz-1',
      email: 'ellie@example.com',
      stripe_customer_id: 'cus_ellie',
      subscription_plan: 'florrie',
      subscription_status: 'active',
      // A stale trial date left over from signup must not buy a free fortnight.
      trial_ends_at: new Date(Date.now() + 9 * DAY).toISOString(),
    };

    await post('/api/billing/create-subscription-intent', { plan: 'florrie_team', interval: 'monthly' });

    expect(stripeState.subscriptionsCreated[0].trial_period_days).toBeUndefined();
  });
});

/* ============================================== the onboarding door agrees = */
describe('the onboarding checkout uses the same trial', () => {
  it('gives a fresh account the full 14 days', async () => {
    currentBeautician = onTrial(0);

    const r = await post('/api/billing/create-checkout', { plan: 'florrie', trial: true, embedded: true });

    expect(r.status).toBe(200);
    expect(stripeState.checkoutSessions[0].subscription_data.trial_period_days).toBe(TRIAL_DAYS);
  });

  it('does not hand out a second fortnight to somebody who comes back on day 5', async () => {
    currentBeautician = onTrial(5);

    await post('/api/billing/create-checkout', { plan: 'florrie', trial: true, embedded: true });

    // Was a flat 14 regardless of how much of the trial had already been used.
    expect(stripeState.checkoutSessions[0].subscription_data.trial_period_days).toBe(9);
  });

  it('writes the plan under the same key on the session and the subscription', async () => {
    currentBeautician = onTrial(0);

    await post('/api/billing/create-checkout', { plan: 'florrie_team', trial: true, embedded: true });

    const s = stripeState.checkoutSessions[0];
    expect(s.metadata.plan).toBe('florrie_team');
    expect(s.subscription_data.metadata.plan).toBe('florrie_team');
  });
});

/* ==================================================== the days arithmetic = */
describe('remainingTrialDays', () => {
  const now = new Date('2026-08-23T12:00:00Z');

  it('rounds a part day up, so nobody loses an afternoon they were promised', () => {
    const beautician = { subscription_plan: 'trial', trial_ends_at: '2026-08-26T09:00:00Z' };
    expect(remainingTrialDays(beautician, now)).toBe(3); // 2 days 21 hours
  });

  it('is 0 for a trial that has run out', () => {
    expect(remainingTrialDays({ subscription_plan: 'trial', trial_ends_at: '2026-08-22T12:00:00Z' }, now)).toBe(0);
  });

  it('is 0 when no trial was ever recorded', () => {
    expect(remainingTrialDays({ subscription_plan: 'trial' }, now)).toBe(0);
    expect(remainingTrialDays({ subscription_plan: 'trial', trial_ends_at: 'not a date' }, now)).toBe(0);
    expect(remainingTrialDays(null, now)).toBe(0);
  });

  it('never exceeds the trial length, whatever the column says', () => {
    const beautician = { subscription_plan: 'trial', trial_ends_at: '2027-08-23T12:00:00Z' };
    expect(remainingTrialDays(beautician, now)).toBe(TRIAL_DAYS);
  });
});
