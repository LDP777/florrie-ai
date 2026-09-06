/**
 * A declined renewal used to produce nothing.
 *
 * Neither webhook handled invoice.payment_failed or invoice.paid. Stripe
 * retried the dead card in silence, the subscription slid to past_due, the
 * paywall locked the diary, and the owner found out from a client who could
 * not book. No email, no banner, no Sentry.
 *
 * Now: invoice.payment_failed marks the salon past_due, stamps
 * payment_failed_at so the grace period has a clock, emails the owner, and
 * tells Sentry. invoice.paid puts it back and clears the stamp.
 *
 * payment_failed_at comes from migration 20260902_backend027, which is
 * applied by hand, so both halves are tested with the column present AND
 * missing. A missing column must cost the marker only, never the status,
 * which is why the two are separate writes.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import { createServer } from 'node:http';

process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_dunning';
process.env.APP_URL = 'https://app.florrie.test';

/* ------------------------------------------------------------- the stripe -- */
const fakeStripe = {
  webhooks: {
    constructEvent: (p) =>
      typeof p === 'string' || Buffer.isBuffer(p) ? JSON.parse(p.toString()) : p,
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
const schema = { paymentFailedAtExists: true };

function makeBuilder(table) {
  const preds = [];
  let pending = null;
  let inserted = null;
  const rows = () => (db[table] || []).filter(r => preds.every(p => p(r)));
  const settle = () => {
    if (pending) {
      // PostgREST: an unknown column anywhere in the payload rejects the
      // WHOLE update, resolved as { data: null, error }.
      if (table === 'beauticians' && !schema.paymentFailedAtExists && 'payment_failed_at' in pending) {
        return { data: null, error: { code: '42703', message: 'column beauticians.payment_failed_at does not exist' } };
      }
      const hit = rows();
      for (const r of hit) Object.assign(r, pending);
      return { data: hit, error: null };
    }
    if (inserted) {
      // stripe_events.id is the PRIMARY KEY; the two webhook routes rely on
      // the 23505 to decide who processes an event.
      if (table === 'stripe_events' && db.stripe_events.some(e => e.id === inserted.id)) {
        return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "stripe_events_pkey"' } };
      }
      db[table].push(inserted);
      return { data: [inserted], error: null };
    }
    return { data: rows(), error: null };
  };
  const b = {
    select() { return b; },
    update(p) { pending = p; return b; },
    insert(p) { inserted = { ...p }; return b; },
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
const emails = [];

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
  requireAuth: (req, _res, next) => { req.beautician = { id: 'biz-1' }; next(); },
}));
vi.mock('../../src/services/notifications.js', () => ({
  notifyBookingConfirmed: async () => ({}),
  sendEmail: async (args) => { emails.push(args); return { id: 'email_1' }; },
}));
vi.mock('../../src/services/push-notifications.js', () => ({ pushBookingConfirmed: async () => {} }));
vi.mock('../../src/services/stripe-cleanup.js', () => ({ cleanupStripeEvents: async () => ({ deleted: 0 }) }));
vi.mock('../../src/services/policy-fees.js', () => ({ chargePolicyFee: async () => ({}) }));

const { default: stripeRouter } = await import('../../src/routes/stripe.js');
const { default: billingRouter } = await import('../../src/routes/billing.js');
const { DUNNING_EVENT_TYPES } = await import('../../src/services/dunning.js');

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

// An invoice the way Stripe sends it for a subscription renewal: the
// subscription's metadata is copied onto subscription_details.
const invoice = (overrides = {}) => ({
  id: 'in_1',
  customer: 'cus_ellie',
  subscription: 'sub_ellie',
  attempt_count: 1,
  amount_due: 2900,
  subscription_details: { metadata: { beautician_id: 'biz-1', plan: 'florrie' } },
  ...overrides,
});
const paymentFailed = (inv = invoice()) => ({ type: 'invoice.payment_failed', data: { object: inv } });
const paid = (inv = invoice()) => ({ type: 'invoice.paid', data: { object: inv } });

const stored = () => db.beauticians.find(b => b.id === 'biz-1');

beforeEach(() => {
  db.beauticians = [{
    id: 'biz-1',
    email: 'ellie@example.com',
    first_name: 'Ellie',
    business_name: 'Ellie Lashes',
    subscription_plan: 'florrie',
    subscription_status: 'active',
    subscription_stripe_id: 'sub_ellie',
    stripe_customer_id: 'cus_ellie',
    payment_failed_at: null,
  }];
  db.stripe_events = [];
  schema.paymentFailedAtExists = true;
  sentryMessages.length = 0;
  sentryExceptions.length = 0;
  loggedErrors.length = 0;
  loggedWarnings.length = 0;
  emails.length = 0;
});

/* ============================================= invoice.payment_failed === */
describe('invoice.payment_failed, column present', () => {
  it('marks the salon past_due and stamps payment_failed_at', async () => {
    const r = await sendEvent(paymentFailed());
    expect(r.status).toBe(200);
    expect(stored().subscription_status).toBe('past_due');
    expect(stored().payment_failed_at).toBeTruthy();
    expect(Number.isNaN(new Date(stored().payment_failed_at).getTime())).toBe(false);
  });

  it('emails the owner: what happened, seven days, the billing page, clients unaffected', async () => {
    await sendEvent(paymentFailed());
    expect(emails).toHaveLength(1);
    const mail = emails[0];
    expect(mail.to).toBe('ellie@example.com');
    expect(mail.subject).toMatch(/payment did not go through/i);
    expect(mail.text).toMatch(/7 days/);
    expect(mail.text).toContain('https://app.florrie.test/pricing');
    expect(mail.text).toMatch(/clients are not affected/i);
    expect(mail.html).toContain('https://app.florrie.test/pricing');
  });

  it('tells Sentry at warning level with the beautician id', async () => {
    await sendEvent(paymentFailed());
    const s = sentryMessages.find(m => /payment failed/i.test(m.msg));
    expect(s).toBeTruthy();
    expect(s.ctx.level).toBe('warning');
    expect(s.ctx.extra.beauticianId).toBe('biz-1');
  });

  it('finds the salon by subscription id when the invoice carries no metadata', async () => {
    await sendEvent(paymentFailed(invoice({ subscription_details: null })));
    expect(stored().subscription_status).toBe('past_due');
  });

  it('finds the salon by customer id as a last resort', async () => {
    await sendEvent(paymentFailed(invoice({ subscription_details: null, subscription: null })));
    expect(stored().subscription_status).toBe('past_due');
  });

  it('does nothing, but says so, for an invoice that matches no salon', async () => {
    await sendEvent(paymentFailed(invoice({ subscription_details: null, subscription: 'sub_nobody', customer: 'cus_nobody' })));
    expect(stored().subscription_status).toBe('active');
    expect(emails).toHaveLength(0);
    expect(loggedWarnings.some(([, msg]) => /no matching beautician/.test(msg))).toBe(true);
  });

  it('is handled on /api/billing/webhook too, since both URLs are mounted', async () => {
    await sendEvent(paymentFailed(), '/api/billing/webhook');
    expect(stored().subscription_status).toBe('past_due');
    expect(emails).toHaveLength(1);
  });

  it('does not process the same event twice across the two URLs', async () => {
    const ev = paymentFailed();
    const id = 'evt_shared';
    const post = (path) => fetch(`http://127.0.0.1:${PORT}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=1,v1=fake' },
      body: JSON.stringify({ id, ...ev }),
    });
    await post('/api/stripe/webhook');
    await post('/api/billing/webhook');
    expect(db.stripe_events.filter(e => e.id === id)).toHaveLength(1);
    expect(emails).toHaveLength(1);
  });
});

describe('invoice.payment_failed, column missing', () => {
  beforeEach(() => {
    schema.paymentFailedAtExists = false;
    delete db.beauticians[0].payment_failed_at;
  });

  it('still writes past_due: the missing marker never blocks the status', async () => {
    await sendEvent(paymentFailed());
    expect(stored().subscription_status).toBe('past_due');
    expect('payment_failed_at' in stored()).toBe(false);
  });

  it('logs the missing column as a warning naming the migration, not as an error', async () => {
    await sendEvent(paymentFailed());
    expect(loggedWarnings.some(([, msg]) => /payment_failed_at is missing/.test(msg) && /20260902_backend027/.test(msg))).toBe(true);
    expect(sentryExceptions).toHaveLength(0);
  });

  it('still emails the owner', async () => {
    await sendEvent(paymentFailed());
    expect(emails).toHaveLength(1);
  });
});

/* ======================================================== invoice.paid === */
describe('invoice.paid, column present', () => {
  beforeEach(() => {
    db.beauticians[0].subscription_status = 'past_due';
    db.beauticians[0].payment_failed_at = '2026-08-30T09:00:00.000Z';
  });

  it('puts the salon back to active and clears the marker', async () => {
    await sendEvent(paid());
    expect(stored().subscription_status).toBe('active');
    expect(stored().payment_failed_at).toBeNull();
  });

  it('invoice.payment_succeeded does the same', async () => {
    await sendEvent({ type: 'invoice.payment_succeeded', data: { object: invoice() } });
    expect(stored().subscription_status).toBe('active');
    expect(stored().payment_failed_at).toBeNull();
  });

  it('sends no email: good news needs no dunning notice', async () => {
    await sendEvent(paid());
    expect(emails).toHaveLength(0);
  });
});

describe('invoice.paid, column missing', () => {
  beforeEach(() => {
    schema.paymentFailedAtExists = false;
    db.beauticians[0].subscription_status = 'past_due';
    delete db.beauticians[0].payment_failed_at;
  });

  it('still writes active', async () => {
    await sendEvent(paid());
    expect(stored().subscription_status).toBe('active');
    expect(sentryExceptions).toHaveLength(0);
  });
});

/* ====================================================== the event list === */
describe('the dunning event types', () => {
  it('cover failed, paid and the older payment_succeeded name', () => {
    expect(DUNNING_EVENT_TYPES).toEqual(expect.arrayContaining(['invoice.payment_failed', 'invoice.paid', 'invoice.payment_succeeded']));
  });
});
