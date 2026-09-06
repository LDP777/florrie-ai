/**
 * "THERE IS NO NOTIFICATION FOR WHEN PEOPLE BOOK NOW, ONLY WHEN THEY TRY AND
 * HAVEN'T PAID DEPOSIT YET."
 *
 * 31 August 2026, the pilot salon owner. She was being told about the bookings
 * that did NOT complete and told nothing about the ones that did.
 *
 * The pending alert fires from routes/booking.js off data already in memory, so
 * it cannot miss. The confirmed alert hung off the payment plumbing: two
 * detached async IIFEs on a Stripe Checkout completion, each swallowing its own
 * errors and throwing away the delivery count sendPush had been returning since
 * 27 August. Everything that made a booking real by another route was therefore
 * silent by construction, and nothing anywhere recorded whether a push had
 * reached a device, so "her phone buzzed" and "she has nothing registered and
 * nothing happened" were the same log line.
 *
 * What is pinned here:
 *
 *   1. A paid booking-page booking tells her EXACTLY ONCE, whichever of the
 *      Stripe webhook and the /confirm redirect gets there first. They race and
 *      Stripe usually wins, and the guard that used to keep them apart
 *      (`if (appt && !appt.deposit_paid)`) is one-shot: four other writers set
 *      deposit_paid, so whichever landed first disarmed it for good.
 *   2. A resent deposit link carries the salon in its SESSION metadata, so the
 *      push goes to a real beautician_id and the transaction actually inserts.
 *      Without it the webhook pushed to `undefined` (zero devices, silently)
 *      and the transactions row was rejected on a NOT NULL, which is money the
 *      client paid that never reached her books.
 *   3. A push that reached zero devices is written down as a failure rather
 *      than looking exactly like a success.
 *   4. booking_pending and booking_confirmed are independent switches now that
 *      beauticians.notification_prefs exists in production.
 *
 * The conversational-booking half of the same incident lives in
 * conversational-booking.test.js, and the cleanup rescue in
 * cleanup-breaker.test.js, because that is where each of those harnesses is.
 */
process.env.TZ = 'UTC';
process.env.STRIPE_SECRET_KEY = 'sk_test_x';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
process.env.FRONTEND_URL = 'https://app.florrie.test';
process.env.PUBLIC_API_URL = 'https://api.florrie.test';
process.env.VAPID_PUBLIC_KEY = 'test-public';
process.env.VAPID_PRIVATE_KEY = 'test-private';
process.env.VAPID_EMAIL = 'mailto:test@florrie.ai';

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import { createServer } from 'node:http';

/* ------------------------------------------------------------------ the db --
 * A small in-memory PostgREST. It resolves the embeds the code actually asks
 * for, and it enforces the one NOT NULL that matters to this incident:
 * transactions.beautician_id (001_initial_schema.sql). A stub that accepts
 * whatever you hand it cannot fail on the resent-deposit bug, which is exactly
 * why it went unnoticed.
 */
const db = {
  appointments: [], clients: [], treatments: [], beauticians: [],
  transactions: [], ai_actions: [], stripe_events: [], push_subscriptions: [],
  payment_links: [], patch_tests: [],
};
const EMBEDS = { clients: 'client_id', treatments: 'treatment_id', beauticians: 'beautician_id' };
let idCounter = 0;
let failAppointmentRead = false;
let failDepositWrite = false;
let failAlertInsert = false;
const nextId = (p) => `${p}_${++idCounter}`;

function embed(table, cols, row) {
  if (!row || table !== 'appointments' || !cols) return row;
  const out = { ...row };
  for (const [name, fk] of Object.entries(EMBEDS)) {
    if (!new RegExp(`(^|[\\s,(])${name}\\s*\\(`).test(cols)) continue;
    out[name] = db[name].find(r => r.id === row[fk]) || null;
  }
  return out;
}

function makeBuilder(table) {
  const filters = [];
  let pending = null;
  let cols = '';
  const ordering = [];
  let rangeStart = 0, rangeEnd = Infinity;
  const valueAt = (row, column) => column.split(/->>?/).reduce((value, key) => value?.[key], row);
  const matching = () => (db[table] || []).filter(r => filters.every(f => f(r))).sort((a,b) => {
    for (const [column, opts] of ordering) {
      const av = valueAt(a, column), bv = valueAt(b, column);
      if (av === bv) continue;
      if (av == null) return opts.nullsFirst ? -1 : 1;
      if (bv == null) return opts.nullsFirst ? 1 : -1;
      return (av < bv ? -1 : 1) * (opts.ascending === false ? -1 : 1);
    }
    return 0;
  }).slice(rangeStart, rangeEnd);

  const settle = () => {
    if (table === 'appointments' && pending?.op === 'update' && pending.payload.deposit_paid && failDepositWrite) return { data: null, error: { code: 'XX000' } };
    if (table === 'ai_actions' && pending?.op === 'insert' && failAlertInsert) return { data: null, error: { code: 'XX000' } };
    if (table === 'appointments' && !pending && failAppointmentRead) return { data: null, error: { code: 'XX000' } };
    if (pending?.op === 'insert') {
      const payload = Array.isArray(pending.payload) ? pending.payload : [pending.payload];
      if (table === 'transactions') {
        const bad = payload.find(p => p.beautician_id === undefined || p.beautician_id === null);
        if (bad) {
          // What Postgres really answers, and what nobody was reading.
          return { data: null, error: { code: '23502', message: 'null value in column "beautician_id" violates not-null constraint' } };
        }
      }
      if (table === 'stripe_events' || table === 'ai_actions') {
        const clash = payload.find(p => db[table].some(e => e.id === p.id));
        if (clash) return { data: null, error: { code: '23505', message: 'duplicate key' } };
      }
      const created = payload.map(p => ({ id: nextId(table), created_at: new Date().toISOString(), management_token: nextId('mt'), ...p }));
      db[table].push(...created);
      return { data: created, error: null };
    }
    if (pending?.op === 'update') {
      const rows = matching();
      for (const r of rows) Object.assign(r, pending.payload);
      return { data: rows.map(r => embed(table, cols, r)), error: null };
    }
    if (pending?.op === 'delete') {
      const hit = new Set(matching());
      db[table] = (db[table] || []).filter(r => !hit.has(r));
      return { data: null, error: null };
    }
    return { data: matching().map(r => embed(table, cols, r)), error: null };
  };
  const b = {
    select(c) { if (typeof c === 'string') cols = c; return b; },
    insert(p) { pending = { op: 'insert', payload: p }; return b; },
    update(p) { pending = { op: 'update', payload: p }; return b; },
    delete() { pending = { op: 'delete' }; return b; },
    eq(c, v) { filters.push(r => c.split(/->>?/).reduce((value, key) => value?.[key], r) === v); return b; },
    neq(c, v) { filters.push(r => r[c] !== v); return b; },
    in(c, v) { filters.push(r => v.includes(r[c])); return b; },
    is(c, v) { filters.push(r => (r[c] ?? null) === v); return b; },
    not() { return b; },
    or() { return b; },
    gt() { return b; }, lt() { return b; }, gte(c,v) { filters.push(r => r[c] >= v); return b; }, lte() { return b; },
    filter() { return b; },
    order(c, opts = {}) { ordering.push([c, opts]); return b; },
    range(start, end) { rangeStart = start; rangeEnd = end + 1; return b; },
    limit(n) { rangeEnd = n; return b; },
    maybeSingle() { const o = settle(); return Promise.resolve(o.error ? o : { data: (o.data || [])[0] || null, error: null }); },
    single() { const o = settle(); return Promise.resolve(o.error ? o : { data: (o.data || [])[0] || null, error: null }); },
    then(res, rej) { return Promise.resolve(settle()).then(res, rej); },
  };
  return b;
}
vi.mock('../../src/config.js', () => ({ supabase: { rpc: async name => { if (name === 'is_deleted_account_event') return { data: false, error: null }; throw new Error('Unexpected RPC: ' + name); }, from: (t) => makeBuilder(t) } }));

/* -------------------------------------------------------------- the stripe --
 * Sessions the code creates are kept, so the resent-deposit metadata can be
 * inspected and then handed back through the webhook exactly as Stripe would.
 */
const stripeState = { created: [], sessions: {} };
vi.mock('stripe', () => ({
  default: class {
    constructor() {
      this.customers = { create: async () => ({ id: 'cus_fake' }) };
      this.checkout = {
        sessions: {
          create: async (args) => {
            stripeState.created.push(args);
            const id = `cs_${stripeState.created.length}`;
            const session = {
              id,
              url: `https://checkout.stripe.com/c/pay/${id}`,
              payment_intent: `pi_${stripeState.created.length}`,
              mode: 'payment',
              payment_status: 'paid',
              status: 'complete',
              amount_total: args.line_items?.[0]?.price_data?.unit_amount ?? 0,
              customer: 'cus_fake',
              metadata: args.metadata || {},
            };
            stripeState.sessions[id] = session;
            return session;
          },
          retrieve: async (id) => stripeState.sessions[id] || null,
        },
      };
      this.paymentIntents = { retrieve: async (id) => ({ id, status: 'succeeded', payment_method: 'pm_1' }) };
      this.events = { list: async () => ({ data: [] }) };
      this.webhooks = {
        constructEvent: (payload, sig) => {
          if (sig !== 'good') throw new Error('bad signature');
          return JSON.parse(typeof payload === 'string' ? payload : payload.toString('utf8'));
        },
      };
    }
  },
}));

/* ------------------------------------------------------------- her devices --
 * The real services/push-notifications.js runs, because the delivery COUNT and
 * the notification_prefs read are two of the four things under test and a
 * mocked push helper cannot fail on either.
 */
const webSent = [];
vi.mock('web-push', () => ({
  default: {
    setVapidDetails: () => {},
    sendNotification: async (sub, payload) => {
      webSent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
      return { statusCode: 201 };
    },
  },
}));
let apnsDevices = 0;
let apnsFails = false;
const apnsSent = [];
vi.mock('../../src/services/apns.js', () => ({
  sendApnsToBeautician: async (id, opts) => {
    if (apnsFails) return { sent: 0, reason: 'all_sends_rejected' };
    if (!apnsDevices) return null;
    apnsSent.push({ id, ...opts });
    return { sent: apnsDevices, removed: 0 };
  },
  isApnsConfigured: () => true,
  sendLiveActivityPush: async () => null,
}));

/* -------------------------------------------------------- everything else -- */
const sentry = { messages: [] };
vi.mock('@sentry/node', () => ({
  captureMessage: (m, o) => sentry.messages.push({ m, o }),
  captureException: () => {},
}));
vi.mock('../../src/lib/logger.js', () => ({
  default: { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, child() { return this; } },
}));
const emails = [];
vi.mock('../../src/services/notifications.js', () => ({
  notifyBookingConfirmed: async () => true,
  sendEmail: async (a) => { emails.push(a); return true; },
  sendSMS: async () => true,
  sendMessage: async () => ({ channel: 'sms' }),
  sendWhatsApp: async () => true,
  pickChannel: () => 'sms',
}));
vi.mock('../../src/services/live-activity.js', () => ({ refreshLiveActivity: async () => true }));
vi.mock('../../src/routes/consultation-forms.js', () => ({
  default: express.Router(),
  sendConsultationFormSMS: async () => true,
  recordBookingConsultation: async () => ({ unrecorded: {}, failed: false }),
}));
vi.mock('../../src/services/policy-fees.js', () => ({
  chargePolicyFee: async () => ({ charged: false }),
  computePolicyFee: () => ({ feeCents: 0 }),
  chargeRescheduleDeposit: async () => ({ charged: false, reason: 'no_deposit' }),
  chargeRemainingBalance: async () => ({ charged: false }),
  chargeCardAmount: async () => ({ charged: false }),
  getCardOnFile: async () => null,
}));
vi.mock('../../src/middleware/turnstile.js', () => ({ verifyTurnstile: (_q, _s, next) => next() }));
vi.mock('../../src/middleware/auth.js', () => ({ requireAuth: (req, _s, next) => { req.beautician = { id: 'salon-1' }; next(); } }));
vi.mock('../../src/middleware/security.js', () => ({
  requireCronKey: (_q, _s, next) => next(),
  idempotencyGuard: (_q, _s, next) => next(),
  resetIdempotencyKeys: () => {},
}));
vi.mock('../../src/services/outstanding-balance.js', () => ({ getOutstandingBalanceCents: async () => ({ owesCents: 0 }) }));
vi.mock('../../src/lib/client-archive.js', () => ({ autoUnarchiveClient: async () => true }));
vi.mock('../../src/lib/outbound-guard.js', () => ({ guardedSend: async () => ({ decision: 'send', delivered: true }) }));
vi.mock('../../src/services/messaging.js', () => ({ sendOnChannel: async () => ({ ok: true }) }));
vi.mock('../../src/services/client-intelligence.js', () => ({ updateClientIntelligence: async () => true }));
vi.mock('../../src/services/email-sequences.js', () => ({ triggerSequence: async () => true }));
vi.mock('../../src/services/review-requests.js', () => ({ scheduleReviewRequest: async () => true }));
vi.mock('../../src/services/loyalty.js', () => ({ awardLoyaltyPoints: async () => true }));
vi.mock('../../src/lib/takings.js', () => ({ logAssumedTakings: async () => true }));
vi.mock('../../src/services/stripe-cleanup.js', () => ({ cleanupStripeEvents: async () => ({ deleted: 0 }) }));

const { default: stripeRouter } = await import('../../src/routes/stripe.js');
const { default: bookingRouter } = await import('../../src/routes/booking.js');
const { pushNewBooking, pushBookingConfirmed } = await import('../../src/services/push-notifications.js');

/* ------------------------------------------------------------- the server -- */
const app = express();
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use('/api/stripe', stripeRouter);
app.use('/api/booking', bookingRouter);
const server = createServer(app);
await new Promise(r => server.listen(0, r));
const PORT = server.address().port;

const post = (path, body, headers = {}) => fetch(`http://127.0.0.1:${PORT}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

const get = (path) => fetch(`http://127.0.0.1:${PORT}${path}`, { redirect: 'manual' })
  .then(r => ({ status: r.status, location: r.headers.get('location') }));

/* -------------------------------------------------------------- the salon -- */
const APPT = 'appt-1';
const SALON = 'salon-1';

function seed(over = {}) {
  for (const t of Object.keys(db)) db[t] = [];
  idCounter = 0;
  webSent.length = 0;
  apnsSent.length = 0;
  emails.length = 0;
  sentry.messages.length = 0;
  stripeState.created.length = 0;
  stripeState.sessions = {};
  apnsDevices = 0;

  db.beauticians.push({
    id: SALON, first_name: 'Ellie', business_name: 'Ellindigo', booking_slug: 'ellindigo',
    stripe_account_id: 'acct_1', stripe_onboarding_complete: true, timezone: 'Europe/London',
    booking_policy: {}, brand_color: '#92405E', phone: '+447700900999',
    // The column migration 002 defines and production did not have until
    // 31 August 2026. Present here so the toggles are actually exercised.
    notification_prefs: {
      booking_confirmed: { email: true, push: true, sms: false },
      booking_pending: { email: true, push: true, sms: false },
    },
    ...over.beautician,
  });
  db.clients.push({ id: 'client-1', beautician_id: SALON, first_name: 'Charlotte', email: 'charlotte@example.com', phone: '07700900123', stripe_customer_id: null });
  db.treatments.push({ id: 'treat-1', beautician_id: SALON, name: 'Hybrid lash set', price_cents: 6500, duration_minutes: 120 });
  db.push_subscriptions.push({ beautician_id: SALON, subscription: { endpoint: 'https://push.example/ellie' } });
  db.appointments.push({
    id: APPT, beautician_id: SALON, client_id: 'client-1', treatment_id: 'treat-1',
    // Wall time in the UTC slot: 10:30 on the Tuesday, and it must read back
    // as 10:30 whatever zone the process is in.
    starts_at: '2026-09-08T10:30:00', ends_at: '2026-09-08T12:30:00',
    status: 'pending', deposit_paid: false, deposit_status: 'pending',
    deposit_cents: 1500, payment_type: 'deposit', client_email: 'charlotte@example.com',
    management_token: 'mt-1', stripe_payment_intent_id: null,
    ...over.appointment,
  });
}

/** A checkout.session.completed exactly as Stripe delivers one. */
function checkoutCompleted(metadata, { id = 'evt_1', sessionId = 'cs_live', amount = 1500 } = {}) {
  return {
    id,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: sessionId, mode: 'payment', payment_status: 'paid', status: 'complete',
        amount_total: amount, payment_intent: 'pi_live', customer: 'cus_fake', metadata,
      },
    },
  };
}

const confirmedAlerts = () => db.ai_actions.filter(a => a.action_type === 'booking_confirmed');
const bookingPushes = () => webSent.filter(p => p.payload.data?.actionType === 'booking_confirmed');

beforeEach(() => { seed(); apnsFails = false; failAppointmentRead = false; failDepositWrite = false; failAlertInsert = false; delete process.env.BOOKING_ALERT_RECONCILE_FROM; });

/* ========================================================================== */

describe('a paid booking-page booking tells her once, whoever gets there first', () => {
  it('the webhook wins the race and the redirect stays quiet', async () => {
    stripeState.sessions.cs_live = {
      id: 'cs_live', payment_status: 'paid', status: 'complete', amount_total: 1500,
      payment_intent: 'pi_live', customer: 'cus_fake',
      metadata: { appointment_id: APPT, beautician_id: SALON, client_id: 'client-1', payment_type: 'deposit' },
    };

    const hook = await post('/api/stripe/webhook',
      checkoutCompleted({ appointment_id: APPT, beautician_id: SALON, client_id: 'client-1', payment_type: 'deposit' }),
      { 'stripe-signature': 'good' });
    expect(hook.status).toBe(200);

    // The client's browser lands a moment later, as it always does.
    const redirect = await get('/api/booking/confirm/cs_live?slug=ellindigo&mt=mt-1');
    expect(redirect.status).toBe(302);

    expect(db.appointments[0].status).toBe('confirmed');
    expect(db.appointments[0].deposit_paid).toBe(true);
    expect(bookingPushes()).toHaveLength(1);
    expect(confirmedAlerts()).toHaveLength(1);
    expect(confirmedAlerts()[0].details.source).toBe('stripe_webhook');
  });

  it('the redirect wins the race and the webhook stays quiet', async () => {
    stripeState.sessions.cs_live = {
      id: 'cs_live', payment_status: 'paid', status: 'complete', amount_total: 1500,
      payment_intent: 'pi_live', customer: 'cus_fake',
      metadata: { appointment_id: APPT, beautician_id: SALON, client_id: 'client-1', payment_type: 'deposit' },
    };

    await get('/api/booking/confirm/cs_live?slug=ellindigo&mt=mt-1');
    await post('/api/stripe/webhook',
      checkoutCompleted({ appointment_id: APPT, beautician_id: SALON, client_id: 'client-1', payment_type: 'deposit' }),
      { 'stripe-signature': 'good' });

    expect(bookingPushes()).toHaveLength(1);
    expect(confirmedAlerts()).toHaveLength(1);
    expect(confirmedAlerts()[0].details.source).toBe('confirm_redirect');
    // And the deposit is still logged once, by whichever path did the money.
    expect(db.transactions.filter(t => t.type === 'deposit')).toHaveLength(1);
  });

  it('a Stripe redelivery of the same event does not buzz her again', async () => {
    const event = checkoutCompleted({ appointment_id: APPT, beautician_id: SALON, client_id: 'client-1', payment_type: 'deposit' });
    await post('/api/stripe/webhook', event, { 'stripe-signature': 'good' });
    await post('/api/stripe/webhook', event, { 'stripe-signature': 'good' });
    // Different event id, same booking: the stripe_events dedupe cannot help,
    // so the status transition is the only thing holding the line.
    await post('/api/stripe/webhook', { ...event, id: 'evt_2' }, { 'stripe-signature': 'good' });

    expect(bookingPushes()).toHaveLength(1);
    expect(confirmedAlerts()).toHaveLength(1);
  });

  it('the push says the wall-clock time, not the local reading of it', async () => {
    await post('/api/stripe/webhook',
      checkoutCompleted({ appointment_id: APPT, beautician_id: SALON, client_id: 'client-1', payment_type: 'deposit' }),
      { 'stripe-signature': 'good' });

    // starts_at is 10:30 salon wall time parked in a UTC slot. In BST a local
    // conversion would say 11:30 and she would go looking for a client who is
    // not coming for another hour.
    expect(bookingPushes()[0].payload.body).toContain('8 Sept at 10:30');
    expect(bookingPushes()[0].payload.body).toContain('Charlotte');
    expect(bookingPushes()[0].payload.body).toContain('Hybrid lash set');
  });
});

describe('a push that reached nothing is written down as a failure', () => {
  it('records alert_delivered 0 and outcome failed when she has no devices', async () => {
    db.push_subscriptions = [];   // no web subscription, and apnsDevices is 0

    await post('/api/stripe/webhook',
      checkoutCompleted({ appointment_id: APPT, beautician_id: SALON, client_id: 'client-1', payment_type: 'deposit' }),
      { 'stripe-signature': 'good' });

    const [row] = confirmedAlerts();
    expect(row).toBeTruthy();
    expect(row.details.alerted_by).toBe('none');
    expect(row.details.alert_delivered).toBe(0);
    // The whole point: this must not read like a delivery.
    expect(row.outcome).toBe('failed');
    expect(row.notification_sent).toBe(false);
    expect(sentry.messages.some(m => m.m === 'Booking confirmed and the owner was told nothing')).toBe(true);
  });

  it('records a real delivery as a success, and counts BOTH channels', async () => {
    apnsDevices = 2;   // her two registered iPhones, plus the one web subscription

    await post('/api/stripe/webhook',
      checkoutCompleted({ appointment_id: APPT, beautician_id: SALON, client_id: 'client-1', payment_type: 'deposit' }),
      { 'stripe-signature': 'good' });

    const [row] = confirmedAlerts();
    expect(row.details.alerted_by).toBe('push');
    expect(row.details.alert_delivered).toBe(3);
    expect(row.outcome).toBe('success');
    expect(row.notification_sent).toBe(true);
  });

  it('a booking she has switched off is suppressed, and is NOT recorded as a failure', async () => {
    db.beauticians[0].notification_prefs = { booking_confirmed: { push: false } };

    await post('/api/stripe/webhook',
      checkoutCompleted({ appointment_id: APPT, beautician_id: SALON, client_id: 'client-1', payment_type: 'deposit' }),
      { 'stripe-signature': 'good' });

    const [row] = confirmedAlerts();
    expect(bookingPushes()).toHaveLength(0);
    expect(row.details.alerted_by).toBe('suppressed');
    // Her own choice is not a defect, and must not turn up in a search for
    // bookings nobody was told about.
    expect(row.outcome).toBe('success');
    expect(sentry.messages.some(m => m.m === 'Booking confirmed and the owner was told nothing')).toBe(false);
  });
});

describe('the two booking switches are independent', () => {
  it('silencing "deposit not completed" leaves the confirmed booking alert alone', async () => {
    db.beauticians[0].notification_prefs = {
      booking_pending: { push: false },
      booking_confirmed: { push: true },
    };

    await pushNewBooking(SALON, 'Charlotte', 'Hybrid lash set', '8 Sep at 10:30', { appointmentId: APPT, apptDate: '2026-09-08T10:30:00', pending: true });
    expect(webSent).toHaveLength(0);

    await pushBookingConfirmed(SALON, 'Charlotte', 'Hybrid lash set', '8 Sep at 10:30', { appointmentId: APPT, apptDate: '2026-09-08T10:30:00' });
    expect(webSent).toHaveLength(1);
    expect(webSent[0].payload.title).toBe('🌸 New booking');
  });

  it('silencing confirmed bookings leaves the deposit-not-completed alert alone', async () => {
    db.beauticians[0].notification_prefs = {
      booking_pending: { push: true },
      booking_confirmed: { push: false },
    };

    await pushBookingConfirmed(SALON, 'Charlotte', 'Hybrid lash set', '8 Sep at 10:30', { appointmentId: APPT });
    expect(webSent).toHaveLength(0);

    await pushNewBooking(SALON, 'Charlotte', 'Hybrid lash set', '8 Sep at 10:30', { appointmentId: APPT, pending: true });
    expect(webSent).toHaveLength(1);
    expect(webSent[0].payload.title).toBe('⌛ Deposit not completed');
  });

  it('a beautician with no booking_pending key at all still gets the pending buzz', async () => {
    // Every row written before 31 August 2026 looks like this. shouldPush fails
    // open on a missing key, which is what keeps the default ON without a
    // backfill having to have run first.
    db.beauticians[0].notification_prefs = { booking_confirmed: { push: true } };

    await pushNewBooking(SALON, 'Charlotte', 'Hybrid lash set', '8 Sep at 10:30', { appointmentId: APPT, pending: true });
    expect(webSent).toHaveLength(1);
  });
});

describe('a resent deposit link', () => {
  it('puts the salon in the SESSION metadata, which is the copy the webhook reads', async () => {
    const res = await post('/api/booking/ellindigo/manage/mt-1/resend-payment', {});
    expect(res.status).toBe(200);

    const session = stripeState.created[0];
    // payment_intent_data carried it all along. The webhook has never read
    // that copy: routes/stripe.js reads session.metadata.
    expect(session.payment_intent_data.metadata.beautician_id).toBe(SALON);
    expect(session.metadata.beautician_id).toBe(SALON);
    expect(session.metadata.client_id).toBe('client-1');
    expect(session.metadata.appointment_id).toBe(APPT);
  });

  it('notifies the right salon and RECORDS the payment when the client pays it', async () => {
    await post('/api/booking/ellindigo/manage/mt-1/resend-payment', {});
    const session = stripeState.created[0];

    // Stripe hands the session metadata straight back on the event.
    await post('/api/stripe/webhook', checkoutCompleted(session.metadata, { sessionId: 'cs_1' }), { 'stripe-signature': 'good' });

    expect(bookingPushes()).toHaveLength(1);
    expect(confirmedAlerts()).toHaveLength(1);
    expect(confirmedAlerts()[0].beautician_id).toBe(SALON);

    // And the money. transactions.beautician_id is NOT NULL, so the old
    // metadata made every resent-deposit payment a PAID BUT NOT RECORDED.
    const deposits = db.transactions.filter(t => t.type === 'deposit');
    expect(deposits).toHaveLength(1);
    expect(deposits[0].beautician_id).toBe(SALON);
    expect(deposits[0].amount_cents).toBe(1500);
  });

  it('the old metadata is what a failure looks like, and it is not silent any more', async () => {
    // The exact shape routes/booking.js used to build: no beautician_id.
    await post('/api/stripe/webhook',
      checkoutCompleted({ appointment_id: APPT, payment_type: 'deposit_resend' }),
      { 'stripe-signature': 'good' });

    // The transaction is rejected on the NOT NULL, exactly as in production.
    expect(db.transactions).toHaveLength(0);
    expect(sentry.messages.some(m => m.m === 'PAID BUT NOT RECORDED: webhook deposit')).toBe(true);
    // And the alert is now driven off the APPOINTMENT rather than off the
    // metadata, so she is told even when the metadata is wrong.
    expect(confirmedAlerts()).toHaveLength(1);
    expect(confirmedAlerts()[0].beautician_id).toBe(SALON);
    expect(bookingPushes()).toHaveLength(1);
  });
});

describe('a payment link against a pending booking', () => {
  it('confirms it and tells her, once', async () => {
    db.payment_links.push({ id: 'pl-1', stripe_session_id: 'cs_pl', status: 'sent' });

    await post('/api/stripe/webhook',
      checkoutCompleted({ type: 'payment_link', appointment_id: APPT, beautician_id: SALON, client_id: 'client-1' }, { sessionId: 'cs_pl' }),
      { 'stripe-signature': 'good' });

    expect(db.appointments[0].status).toBe('confirmed');
    expect(confirmedAlerts()).toHaveLength(1);
    expect(bookingPushes()).toHaveLength(1);
  });
});


describe('confirmation delivery retry and payment truth', () => {
  it('retries the same paid webhook after APNs failure without repeating web delivery or transactions', async () => {
    apnsDevices = 1;
    apnsFails = true;
    const event = checkoutCompleted({ appointment_id: APPT, beautician_id: SALON, client_id: 'client-1', payment_type: 'deposit' });
    await post('/api/stripe/webhook', event, { 'stripe-signature': 'good' });
    expect(db.appointments[0].status).toBe('confirmed');
    expect(confirmedAlerts()[0].outcome).toBe('failed');
    expect(bookingPushes()).toHaveLength(1);
    const transactions = db.transactions.length;
    apnsFails = false;
    await post('/api/stripe/webhook', event, { 'stripe-signature': 'good' });
    expect(apnsSent).toHaveLength(1);
    expect(apnsSent[0].data.url).toContain(`appt=${APPT}`);
    expect(bookingPushes()).toHaveLength(1);
    expect(db.transactions).toHaveLength(transactions);
    expect(confirmedAlerts()).toHaveLength(1);
    expect(confirmedAlerts()[0].outcome).toBe('success');
    await post('/api/stripe/webhook', event, { 'stripe-signature': 'good' });
    expect(apnsSent).toHaveLength(1);
  });

  it('delivers a paid booking to an iPhone with no web subscription', async () => {
    db.push_subscriptions = []; apnsDevices = 1;
    await post('/api/stripe/webhook', checkoutCompleted({ appointment_id: APPT, beautician_id: SALON, client_id: 'client-1' }), { 'stripe-signature': 'good' });
    expect(apnsSent).toHaveLength(1);
    expect(confirmedAlerts()[0].notification_sent).toBe(true);
  });

  it('does not confirm unpaid completed Checkout, then confirms asynchronous payment success', async () => {
    const event = checkoutCompleted({ appointment_id: APPT, beautician_id: SALON, client_id: 'client-1' });
    event.data.object.payment_status = 'unpaid';
    await post('/api/stripe/webhook', event, { 'stripe-signature': 'good' });
    expect(db.appointments[0].status).toBe('pending');
    expect(db.appointments[0].deposit_paid).toBe(false);
    expect(confirmedAlerts()).toHaveLength(0);
    event.id = 'evt_async'; event.type = 'checkout.session.async_payment_succeeded'; event.data.object.payment_status = 'paid';
    await post('/api/stripe/webhook', event, { 'stripe-signature': 'good' });
    expect(db.appointments[0].status).toBe('confirmed');
    expect(bookingPushes()).toHaveLength(1);
  });

  it('does not resurrect a cancelled appointment on a late paid event', async () => {
    db.appointments[0].status = 'cancelled';
    await post('/api/stripe/webhook', checkoutCompleted({ appointment_id: APPT, beautician_id: SALON, client_id: 'client-1' }), { 'stripe-signature': 'good' });
    expect(db.appointments[0].status).toBe('cancelled');
    expect(bookingPushes()).toHaveLength(0);
  });

  it('serializes concurrent no-deposit announcements and does not claim a deposit was paid', async () => {
    const { announceBookingConfirmed } = await import('../../src/services/booking-confirmed-alert.js');
    db.appointments[0].status = 'confirmed'; db.appointments[0].deposit_cents = 0;
    await Promise.all(Array.from({ length: 5 }, () => announceBookingConfirmed(APPT, { claim: false, source: 'free_booking' })));
    expect(bookingPushes()).toHaveLength(1);
    expect(bookingPushes()[0].payload.body).not.toContain('Deposit paid');
    expect(confirmedAlerts()).toHaveLength(1);
  });
});


describe('manual confirmation and scheduled retries', () => {
  it('manual status confirmation emits the same iPhone alert without saying deposit paid', async () => {
    db.push_subscriptions = []; apnsDevices = 1;
    const response = await fetch(`http://127.0.0.1:${PORT}/api/booking/appointments/${APPT}/status`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'confirmed' }),
    });
    expect(response.status).toBe(200);
    expect(apnsSent).toHaveLength(1);
    expect(apnsSent[0].body).not.toContain('Deposit paid');
    expect(confirmedAlerts()[0].outcome).toBe('success');
  });
  it('scheduled retry recovers APNs without a browser redirect or repeated webhook', async () => {
    const { retryBookingConfirmedAlerts } = await import('../../src/services/booking-confirmed-alert.js');
    process.env.BOOKING_ALERT_RECONCILE_FROM = new Date(Date.now() - 60_000).toISOString();
    db.push_subscriptions = []; apnsDevices = 1; apnsFails = true;
    await post('/api/stripe/webhook', checkoutCompleted({ appointment_id: APPT, beautician_id: SALON, client_id: 'client-1' }), { 'stripe-signature': 'good' });
    apnsFails = false;
    expect(await retryBookingConfirmedAlerts()).toEqual({ attempted: 1 });
    expect(apnsSent).toHaveLength(1);
    expect(await retryBookingConfirmedAlerts()).toEqual({ attempted: 0 });
  });
});


it('a failed read after confirmation does not consume the right to notify', async () => {
  const { announceBookingConfirmed } = await import('../../src/services/booking-confirmed-alert.js');
  failAppointmentRead = true;
  expect((await announceBookingConfirmed(APPT)).reason).toBe('appointment_unreadable');
  expect(db.appointments[0].status).toBe('confirmed');
  expect(bookingPushes()).toHaveLength(0);
  failAppointmentRead = false;
  await announceBookingConfirmed(APPT);
  expect(bookingPushes()).toHaveLength(1);
});

it('a live delivery lease blocks retry but an abandoned lease can be recovered', async () => {
  const { announceBookingConfirmed } = await import('../../src/services/booking-confirmed-alert.js');
  apnsFails = true; db.push_subscriptions = [];
  await announceBookingConfirmed(APPT);
  const row = confirmedAlerts()[0]; row.outcome = 'pending';
  row.details.lease_until = new Date(Date.now() + 60_000).toISOString();
  expect((await announceBookingConfirmed(APPT)).reason).toBe('delivery_in_progress');
  row.details.lease_until = new Date(Date.now() - 60_000).toISOString();
  apnsFails = false; apnsDevices = 1;
  await announceBookingConfirmed(APPT);
  expect(apnsSent).toHaveLength(1);
  expect(row.outcome).toBe('success');
});


describe('payment event waits for saved payment and durable notification intent', () => {
  for (const fault of ['appointment_read', 'deposit_write', 'alert_insert']) {
    it(`retries the signed Stripe event after ${fault} failure without duplicate money`, async () => {
      const event = checkoutCompleted({ appointment_id: APPT, beautician_id: SALON, client_id: 'client-1' });
      failAppointmentRead = fault === 'appointment_read';
      failDepositWrite = fault === 'deposit_write';
      failAlertInsert = fault === 'alert_insert';
      const failed = await post('/api/stripe/webhook', event, { 'stripe-signature': 'good' });
      expect(failed.status).toBe(503);
      expect(db.stripe_events[0].processed_at).toBeNull();
      expect(bookingPushes()).toHaveLength(0);
      failAppointmentRead = false; failDepositWrite = false; failAlertInsert = false;
      const recovered = await post('/api/stripe/webhook', event, { 'stripe-signature': 'good' });
      expect(recovered.status).toBe(200);
      expect(db.stripe_events[0].processed_at).toBeTruthy();
      expect(db.appointments[0].deposit_paid).toBe(true);
      expect(bookingPushes()).toHaveLength(1);
      expect(db.transactions.filter(t => t.type === 'deposit')).toHaveLength(1);
      await post('/api/stripe/webhook', event, { 'stripe-signature': 'good' });
      expect(bookingPushes()).toHaveLength(1);
      expect(db.transactions.filter(t => t.type === 'deposit')).toHaveLength(1);
    });
  }
  it('an unpaid Checkout redirect does not confirm or record a deposit', async () => {
    stripeState.sessions.cs_unpaid = { payment_status: 'unpaid', status: 'complete', metadata: { appointment_id: APPT } };
    await get('/api/booking/confirm/cs_unpaid?slug=ellindigo&mt=mt-1');
    expect(db.appointments[0].status).toBe('pending');
    expect(db.appointments[0].deposit_paid).toBe(false);
    expect(bookingPushes()).toHaveLength(0);
  });
});


it('rollout-bounded reconciliation recovers a free booking with no intent and skips historical bookings', async () => {
  const { announceBookingConfirmed, retryBookingConfirmedAlerts } = await import('../../src/services/booking-confirmed-alert.js');
  const boundary = new Date(Date.now() - 60_000).toISOString();
  process.env.BOOKING_ALERT_RECONCILE_FROM = boundary;
  Object.assign(db.appointments[0], { status: 'confirmed', created_at: new Date().toISOString(), starts_at: new Date(Date.now() + 86400000).toISOString(), deposit_cents: 0 });
  db.appointments.push({ ...db.appointments[0], id: 'historical', created_at: new Date(Date.now() - 3600000).toISOString() });
  // A legacy failed attempt must remain silent after enabling the new job.
  db.ai_actions.push({ id: 'legacy-alert', appointment_id: 'historical', action_type: 'booking_confirmed', outcome: 'failed', created_at: new Date(Date.now() - 3600000).toISOString() });
  failAlertInsert = true;
  await announceBookingConfirmed(APPT, { claim: false });
  expect(confirmedAlerts()).toHaveLength(1);
  failAlertInsert = false;
  await retryBookingConfirmedAlerts();
  expect(bookingPushes()).toHaveLength(1);
  expect(confirmedAlerts().find(row => row.appointment_id === APPT)?.outcome).toBe('success');
  await retryBookingConfirmedAlerts();
  expect(bookingPushes()).toHaveLength(1);
});


it('reconciliation advances beyond the first hundred already-announced bookings', async () => {
  const { announceBookingConfirmed, retryBookingConfirmedAlerts } = await import('../../src/services/booking-confirmed-alert.js');
  process.env.BOOKING_ALERT_RECONCILE_FROM = new Date(Date.now() - 120_000).toISOString();
  const base = { ...db.appointments[0], status: 'confirmed', starts_at: new Date(Date.now() + 86400000).toISOString() };
  db.appointments = Array.from({ length: 101 }, (_, i) => ({ ...base, id: `page-${String(i).padStart(3, '0')}`, created_at: new Date(Date.now() - 60_000 + i).toISOString() }));
  for (const appointment of db.appointments.slice(0,100)) {
    await announceBookingConfirmed(appointment.id, { claim: false });
  }
  webSent.length = 0;
  await retryBookingConfirmedAlerts();
  expect(bookingPushes()).toHaveLength(0);
  await retryBookingConfirmedAlerts();
  expect(bookingPushes()).toHaveLength(1);
  expect(confirmedAlerts().find(row => row.appointment_id === 'page-100')?.outcome).toBe('success');
});

it('automatic retry is disabled without a valid rollout boundary', async () => {
  const { announceBookingConfirmed, retryBookingConfirmedAlerts } = await import('../../src/services/booking-confirmed-alert.js');
  db.push_subscriptions = []; apnsFails = true;
  await announceBookingConfirmed(APPT);
  apnsFails = false; apnsDevices = 1;
  process.env.BOOKING_ALERT_RECONCILE_FROM = 'invalid';
  expect(await retryBookingConfirmedAlerts()).toEqual({ attempted: 0 });
  expect(apnsSent).toHaveLength(0);
});
