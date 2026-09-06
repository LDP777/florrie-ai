/**
 * THE FIRST BOOKING A NEW SALON EVER TAKES.
 *
 * She signs up, adds her treatments, never opens the payments page, never
 * connects Stripe, and shares her link. A real client picks a real slot. What
 * used to happen next, in order:
 *
 *  1. migration 029 gives every row payment_settings
 *     '{"require_deposit": false, "deposit_amount": "£10", ...}'.
 *     resolveDepositCents read the amount and never the switch, so the booking
 *     page charged £10 nobody had asked for.
 *  2. No Stripe account, so there was no Checkout session to open. The route
 *     answered 201 with status 'pending' and "your beautician will send a
 *     payment link", which nothing in Florrie sends.
 *  3. The new-booking push was gated on `status !== 'pending'`, so the owner
 *     was never told the booking existed at all.
 *  4. Fifteen minutes later the stale sweep cancelled it, texted the client
 *     that her deposit was not paid, and pushed the owner that somebody had
 *     started a booking and not paid. Nobody had ever been asked for money.
 *  5. Meanwhile the Setup Hub checklist read require_deposit and reported
 *     "deposits: not switched on" about the page that was charging one.
 *
 * Every test here fails against that code.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const db = {
  beauticians: [], treatments: [], clients: [], appointments: [], hours_exceptions: [],
  ai_actions: [], transactions: [], waitlist: [], promo_codes: [], gift_vouchers: [],
  stripe_events: [], consultation_forms: [], patch_tests: [],
};
let idCounter = 0;
const nextId = (p) => `${p}_${++idCounter}`;

/** `deposit_cents.gt.0,deposit_percent.gt.0` and friends, as a predicate. */
function orPredicate(expr) {
  const clauses = String(expr).split(',').map((raw) => {
    const [col, op, ...rest] = raw.split('.');
    const value = rest.join('.');
    switch (op) {
      case 'gt': return r => Number(r[col] ?? 0) > Number(value);
      case 'lt': return r => Number(r[col] ?? 0) < Number(value);
      case 'eq': return r => String(r[col] ?? '') === value || (value === 'false' && r[col] === false);
      case 'is': return r => (r[col] ?? null) === (value === 'null' ? null : value);
      default: return () => true;
    }
  });
  return r => clauses.some(f => f(r));
}

function makeBuilder(table) {
  const filters = [];
  let pending = null;
  let headCount = false;
  const matching = () => (db[table] || []).filter(r => filters.every(f => f(r)));
  const settle = () => {
    if (headCount) return { data: null, error: null, count: matching().length };
    if (pending?.op === 'insert') {
      const payload = Array.isArray(pending.payload) ? pending.payload : [pending.payload];
      const created = payload.map(p => ({
        id: nextId(table), management_token: nextId('mt'),
        created_at: new Date().toISOString(), ...p,
      }));
      db[table].push(...created);
      return { data: created, error: null };
    }
    if (pending?.op === 'update') {
      const rows = matching();
      for (const r of rows) Object.assign(r, pending.payload);
      return { data: rows, error: null };
    }
    return { data: matching(), error: null };
  };
  const b = {
    select(_c, opts) { if (opts?.head) headCount = true; return b; },
    insert(p) { pending = { op: 'insert', payload: p }; return b; },
    update(p) { pending = { op: 'update', payload: p }; return b; },
    delete() { pending = { op: 'delete' }; return b; },
    eq(c, v) { filters.push(r => c.split(/->>?/).reduce((value, key) => value?.[key], r) === v); return b; },
    neq(c, v) { filters.push(r => r[c] !== v); return b; },
    in(c, v) { filters.push(r => v.includes(r[c])); return b; },
    is(c, v) { filters.push(r => (r[c] ?? null) === v); return b; },
    or(expr) { filters.push(orPredicate(expr)); return b; },
    not(c, op, v) {
      if (op === 'in') { const list = String(v).replace(/[()]/g, '').split(','); filters.push(r => !list.includes(String(r[c]))); }
      else filters.push(r => (r[c] ?? null) !== null);
      return b;
    },
    ilike(c, v) {
      const needle = String(v).replace(/%/g, '').toLowerCase();
      filters.push(r => String(r[c] ?? '').toLowerCase().includes(needle));
      return b;
    },
    gte(c, v) { filters.push(r => String(r[c]) >= String(v)); return b; },
    lte(c, v) { filters.push(r => String(r[c]) <= String(v)); return b; },
    gt(c, v) { filters.push(r => String(r[c]) > String(v)); return b; },
    lt(c, v) { filters.push(r => String(r[c]) < String(v)); return b; },
    order() { return b; },
    limit() { return b; },
    maybeSingle() { const o = settle(); return Promise.resolve(o.error ? o : { data: (o.data || [])[0] || null, error: null }); },
    single() { const o = settle(); return Promise.resolve(o.error ? o : { data: (o.data || [])[0] || null, error: null }); },
    then(res, rej) { return Promise.resolve(settle()).then(res, rej); },
    catch(rej) { return Promise.resolve(settle()).catch(rej); },
  };
  return b;
}

vi.mock('../../src/config.js', () => ({ supabase: { from: (t) => makeBuilder(t) } }));

const stripeState = { sessions: [] };
vi.mock('stripe', () => ({
  default: class {
    constructor() {
      this.customers = { create: async () => ({ id: 'cus_fake' }) };
      this.checkout = { sessions: { create: async (args) => {
        stripeState.sessions.push(args);
        return { id: 'cs_fake', url: 'https://checkout.stripe.com/c/pay/cs_fake', payment_intent: 'pi_fake' };
      } } };
      this.paymentIntents = { retrieve: async (id) => ({ id, status: 'requires_payment_method' }) };
      this.events = { list: async () => ({ data: [] }) };
    }
  },
}));

const told = { confirmed: [] };
vi.mock('../../src/services/notifications.js', () => ({
  notifyBookingConfirmed: async (id) => { told.confirmed.push(id); return true; },
  sendMessage: async () => ({ channel: 'sms' }),
  sendWhatsApp: async () => true,
  sendSMS: async () => true,
  sendEmail: async () => true,
  pickChannel: () => 'sms',
}));

const pushes = { newBooking: [], confirmed: [], team: [] };
vi.mock('../../src/services/push-notifications.js', () => ({
  pushNewBooking: async (beauticianId, clientName, treatmentName, dateStr, opts = {}) => {
    pushes.newBooking.push({ beauticianId, clientName, treatmentName, dateStr, ...opts });
    return true;
  },
  pushTeamUpdate: async (beauticianId, type, body, opts = {}) => {
    pushes.team.push({ beauticianId, type, body, ...opts });
    return true;
  },
  pushBookingConfirmed: async (beauticianId, clientName, treatmentName, dateStr, opts = {}) => {
    pushes.confirmed.push({ beauticianId, clientName, treatmentName, dateStr, ...opts });
    return { sent: 1, delivered: 1 };
  },
  pushReschedule: async () => true,
  pushPatchTestBooked: async () => true,
  pushClientCancelled: async () => true,
}));
vi.mock('../../src/services/live-activity.js', () => ({ refreshLiveActivity: async () => true }));
vi.mock('../../src/routes/consultation-forms.js', () => ({
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
vi.mock('../../src/middleware/turnstile.js', () => ({ verifyTurnstile: (_req, _res, next) => next() }));
vi.mock('../../src/middleware/auth.js', () => ({ requireAuth: (_req, _res, next) => next() }));
vi.mock('../../src/services/outstanding-balance.js', () => ({ getOutstandingBalanceCents: async () => ({ owesCents: 0 }) }));
vi.mock('../../src/lib/client-archive.js', () => ({ autoUnarchiveClient: async () => true }));

const toldClient = [];
vi.mock('../../src/lib/outbound-guard.js', () => ({
  guardedSend: async (args) => { toldClient.push(args); return { decision: 'send', delivered: true }; },
}));
vi.mock('../../src/services/messaging.js', () => ({ sendOnChannel: async () => ({ ok: true }) }));
vi.mock('../../src/services/client-intelligence.js', () => ({ updateClientIntelligence: async () => true }));
vi.mock('../../src/services/email-sequences.js', () => ({ triggerSequence: async () => true }));
vi.mock('../../src/services/review-requests.js', () => ({ scheduleReviewRequest: async () => true }));
vi.mock('../../src/services/loyalty.js', () => ({ awardLoyaltyPoints: async () => true }));
vi.mock('../../src/lib/takings.js', () => ({ logAssumedTakings: async () => true }));
vi.mock('@sentry/node', () => ({ captureMessage: () => {}, captureException: () => {} }));

process.env.STRIPE_SECRET_KEY = 'sk_test_x';
process.env.FRONTEND_URL = 'https://florrie.ai';

const bookingRouter = (await import('../../src/routes/booking.js')).default;
const setupRouter = (await import('../../src/routes/setup.js')).default;
const { cleanupStaleBookings } = await import('../../src/services/cleanup.js');
const { resolveDepositCents, salonDepositIsConfigured } = await import('../../src/lib/booking-rules.js');

/** Drive one route handler straight, no HTTP server, no middleware. */
async function run(router, method, path, req) {
  const layer = router.stack.find(l => l.route?.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`no ${method} ${path}`);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const out = { status: 200, body: null };
  const res = {
    status(c) { out.status = c; return res; },
    json(p) { out.body = p; return res; },
    redirect() { return res; },
    get() { return 'api.florrie.ai'; },
  };
  await handler({ headers: {}, get: () => 'api.florrie.ai', query: {}, body: {}, ...req }, res);
  return out;
}

const ALL_WEEK = {
  mon: { start: '09:00', end: '18:00' }, tue: { start: '09:00', end: '18:00' },
  wed: { start: '09:00', end: '18:00' }, thu: { start: '09:00', end: '18:00' },
  fri: { start: '09:00', end: '18:00' }, sat: { start: '09:00', end: '18:00' },
  sun: { start: '09:00', end: '18:00' },
};

/** The next dated weekday at 11:00, wall time, comfortably inside the horizon. */
function nextWeekday(targetDow, weeksAhead = 3) {
  const d = new Date(Date.now() + weeksAhead * 7 * 24 * 60 * 60 * 1000);
  d.setUTCHours(11, 0, 0, 0);
  while (d.getUTCDay() !== targetDow) d.setUTCDate(d.getUTCDate() + 1);
  return `${d.toISOString().slice(0, 16)}:00`;
}

// Exactly what migration 029 writes on a brand new row, character for character.
const MIGRATION_029_DEFAULT = {
  require_deposit: false,
  deposit_amount: '£10',
  no_show_fee: false,
  accepted_methods: ['cash'],
};

const settle = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => {
  for (const t of Object.keys(db)) db[t] = [];
  idCounter = 0;
  told.confirmed.length = 0;
  pushes.newBooking.length = 0;
  pushes.confirmed.length = 0;
  pushes.team.length = 0;
  toldClient.length = 0;
  stripeState.sessions.length = 0;

  // Sadie, four days in. No Stripe, no payment settings she has ever touched.
  db.beauticians.push({
    id: 'b_new', booking_slug: 'sadie', business_name: 'Sadie Beauty', first_name: 'Sadie',
    timezone: 'Europe/London', stripe_account_id: null, stripe_onboarding_complete: false,
    booking_policy: {}, payment_settings: { ...MIGRATION_029_DEFAULT }, working_hours: ALL_WEEK,
    client_reminder_prefs: {},
  });
  // Ellie, trading for a year, Stripe connected, deposit set on the treatment.
  db.beauticians.push({
    id: 'b_old', booking_slug: 'ellindigo', business_name: 'Ellindigo', first_name: 'Ellie',
    timezone: 'Europe/London', stripe_account_id: 'acct_1', stripe_onboarding_complete: true,
    booking_policy: {}, payment_settings: { ...MIGRATION_029_DEFAULT }, working_hours: ALL_WEEK,
    client_reminder_prefs: {},
  });

  db.treatments.push({
    id: 't_plain', beautician_id: 'b_new', name: 'Gel manicure', duration_minutes: 60,
    buffer_minutes: 0, price_cents: 3500, deposit_cents: 0, deposit_percent: 0,
    is_active: true, booking_enabled: true, requires_patch_test: false,
    requires_consultation: false, consultation_form_id: null,
  });
  db.treatments.push({
    id: 't_deposit', beautician_id: 'b_old', name: 'Hybrid stain', duration_minutes: 60,
    buffer_minutes: 0, price_cents: 8000, deposit_cents: 2000, deposit_percent: null,
    is_active: true, booking_enabled: true, requires_patch_test: false,
    requires_consultation: false, consultation_form_id: null,
  });
  db.stripe_events.push({ id: 'evt_1', processed_at: new Date().toISOString() });
});

const bookBody = (over = {}) => ({
  treatment_id: 't_plain',
  starts_at: nextWeekday(3),
  client_name: 'Priya Nair',
  client_email: 'priya@example.com',
  client_phone: '07700900123',
  payment_type: 'deposit',
  ...over,
});

// ---------------------------------------------------------------------------
// 1. The switch
// ---------------------------------------------------------------------------

describe('the deposit a salon has not switched on', () => {
  it('is not charged just because the migration default left an amount lying there', () => {
    expect(resolveDepositCents({
      treatments: [{ price_cents: 3500, deposit_cents: 0, deposit_percent: 0 }],
      paymentSettings: MIGRATION_029_DEFAULT,
    })).toBe(0);
  });

  it('is charged once she actually switches it on', () => {
    expect(resolveDepositCents({
      treatments: [{ price_cents: 3500, deposit_cents: 0, deposit_percent: 0 }],
      paymentSettings: { ...MIGRATION_029_DEFAULT, require_deposit: true },
    })).toBe(1000);
  });

  it('reads deposit_required too, the spelling the settings page also accepts', () => {
    expect(resolveDepositCents({
      treatments: [{ price_cents: 3500 }],
      paymentSettings: { deposit_required: true, deposit_amount: '£20' },
    })).toBe(2000);
  });

  it('does not invent an amount when the switch is on and the amount is blank', () => {
    expect(resolveDepositCents({
      treatments: [{ price_cents: 3500 }],
      paymentSettings: { require_deposit: true, deposit_amount: '' },
    })).toBe(0);
  });

  // The judgement call. A number typed against one treatment is the most
  // specific thing anybody has said about it, and a global switch that nothing
  // in the app can even set is not a reason to throw it away.
  it('still takes a deposit the treatment itself carries, switch or no switch', () => {
    expect(resolveDepositCents({
      treatments: [{ price_cents: 8000, deposit_cents: 2000, deposit_percent: 0 }],
      paymentSettings: MIGRATION_029_DEFAULT,
    })).toBe(2000);
  });
});

// ---------------------------------------------------------------------------
// 5. The checklist and the booking page answer the same question
// ---------------------------------------------------------------------------

describe('the Setup Hub checklist agrees with the booking page', () => {
  const salonStates = [
    ['the migration default', MIGRATION_029_DEFAULT],
    ['switched on with an amount', { require_deposit: true, deposit_amount: '£15' }],
    ['switched on with a percentage', { require_deposit: true, deposit_amount: '25%' }],
    ['switched on with nothing behind it', { require_deposit: true, deposit_amount: '' }],
    ['switched off with an amount left over', { require_deposit: false, deposit_amount: '£25' }],
    ['nothing at all', {}],
  ];

  for (const [label, paymentSettings] of salonStates) {
    it(`says the same thing as the booking page for ${label}`, async () => {
      const chargedByBookingPage = resolveDepositCents({
        treatments: [{ price_cents: 4000, deposit_cents: 0, deposit_percent: 0 }],
        paymentSettings,
      }) > 0;

      // The pure rule the checklist calls...
      expect(salonDepositIsConfigured(paymentSettings)).toBe(chargedByBookingPage);

      // ...and the route that renders the tick, end to end.
      const out = await run(setupRouter, 'get', '/status', {
        beautician: { id: 'b_new', business_name: 'Sadie Beauty', booking_slug: 'sadie', working_hours: ALL_WEEK, payment_settings: paymentSettings },
      });
      expect(out.body.services.deposits).toBe(chargedByBookingPage);
    });
  }

  it('still ticks deposits when a treatment carries its own', async () => {
    const out = await run(setupRouter, 'get', '/status', {
      beautician: { id: 'b_old', business_name: 'Ellindigo', booking_slug: 'ellindigo', working_hours: ALL_WEEK, payment_settings: MIGRATION_029_DEFAULT },
    });
    expect(out.body.services.deposits).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2 and 3. The booking itself
// ---------------------------------------------------------------------------

describe('a booking page that has never been set up takes an ordinary booking', () => {
  it('charges nothing, confirms the slot, and tells the owner it happened', async () => {
    const out = await run(bookingRouter, 'post', '/:slug/book', {
      params: { slug: 'sadie' }, body: bookBody(),
    });
    await settle();

    expect(out.status).toBe(201);
    expect(out.body.booking.deposit).toBeNull();
    expect(out.body.booking.status).toBe('confirmed');
    expect(out.body.booking.deposit_pending).toBeFalsy();
    // No promise of a payment link, because nothing sends one.
    expect(JSON.stringify(out.body)).not.toMatch(/payment link/i);

    const appt = db.appointments[0];
    expect(appt.deposit_cents).toBe(0);
    expect(appt.status).toBe('confirmed');
    expect(appt.payment_expires_at ?? null).toBeNull();

    expect(told.confirmed, 'the client was not told she is booked').toContain(appt.id);
    expect(pushes.confirmed, 'the owner was never told about her first booking').toHaveLength(1);
    expect(pushes.confirmed[0].depositPaid).toBe(false);
  });

  it('leaves nothing for the sweep to release', async () => {
    await run(bookingRouter, 'post', '/:slug/book', { params: { slug: 'sadie' }, body: bookBody() });
    db.appointments[0].created_at = new Date(Date.now() - 20 * 60 * 1000).toISOString();

    const r = await cleanupStaleBookings();
    await settle();

    expect(r.cancelled).toBe(0);
    expect(db.appointments[0].status).toBe('confirmed');
    expect(toldClient, 'the client was told her slot had gone').toHaveLength(0);
  });
});

describe('a salon that does want a deposit but cannot take one', () => {
  beforeEach(() => {
    const sadie = db.beauticians.find(b => b.id === 'b_new');
    sadie.payment_settings = { ...MIGRATION_029_DEFAULT, require_deposit: true };
  });

  it('confirms the booking rather than holding a slot nobody can pay for', async () => {
    const out = await run(bookingRouter, 'post', '/:slug/book', {
      params: { slug: 'sadie' }, body: bookBody(),
    });
    await settle();

    expect(out.status).toBe(201);
    expect(out.body.checkout_url).toBeUndefined();
    expect(db.appointments[0].status).toBe('confirmed');
    // The figure is still on the row, so it shows as awaiting in the deposit
    // tracker and she knows there is £10 to ask for.
    expect(db.appointments[0].deposit_cents).toBe(1000);
    expect(told.confirmed).toHaveLength(1);
  });

  it('tells the owner the money could not be taken online', async () => {
    await run(bookingRouter, 'post', '/:slug/book', { params: { slug: 'sadie' }, body: bookBody() });
    await settle();

    expect(pushes.confirmed).toHaveLength(1);
    const money = pushes.team.find(p => /could not be taken online/i.test(p.body));
    expect(money, 'nothing told her the deposit had not been collected').toBeTruthy();
    expect(money.body).toContain('£10.00');
  });
});

describe('a pending booking is still a booking she is told about', () => {
  it('pushes the pending wording when the deposit is genuinely on its way', async () => {
    const out = await run(bookingRouter, 'post', '/:slug/book', {
      params: { slug: 'ellindigo' }, body: bookBody({ treatment_id: 't_deposit' }),
    });
    await settle();

    expect(out.status).toBe(201);
    expect(out.body.checkout_url).toContain('checkout.stripe.com');
    expect(db.appointments[0].status).toBe('pending');

    expect(pushes.newBooking, 'a pending booking was silent').toHaveLength(1);
    expect(pushes.newBooking[0].pending, 'the pending booking was announced as a confirmed one').toBe(true);
    // And she is not told it is confirmed until the money lands.
    expect(told.confirmed).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. The sweep
// ---------------------------------------------------------------------------

describe('the sweep does not release a booking that was never payable', () => {
  const legacyPending = (over = {}) => ({
    id: 'a_legacy', beautician_id: 'b_new', client_id: 'c1',
    starts_at: nextWeekday(3), created_at: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
    deposit_cents: 1000, deposit_paid: false, payment_expires_at: null,
    google_event_id: null, stripe_payment_intent_id: null, status: 'pending',
    treatments: { name: 'Gel manicure' }, clients: { first_name: 'Priya' }, ...over,
  });

  beforeEach(() => {
    db.clients.push({ id: 'c1', beautician_id: 'b_new', first_name: 'Priya', phone: '07700900123', email: 'priya@example.com', whatsapp_id: null });
  });

  it('confirms it instead, and says nothing about an unpaid deposit', async () => {
    db.appointments.push(legacyPending());

    const r = await cleanupStaleBookings();
    await settle();

    expect(r.cancelled).toBe(0);
    expect(r.confirmedUnpayable).toBe(1);
    expect(db.appointments[0].status).toBe('confirmed');
    expect(toldClient, 'the client was told she had not paid a deposit nobody asked her for').toHaveLength(0);
    expect(pushes.team.some(p => /didn't pay/i.test(p.body)), 'the owner was told the client did not pay').toBe(false);
    expect(pushes.team.some(p => /could not be taken online/i.test(p.body))).toBe(true);
  });

  it('clears a past one quietly rather than texting about a slot that has been and gone', async () => {
    db.appointments.push(legacyPending({
      starts_at: '2026-01-14T11:00:00Z',
      created_at: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
    }));

    const r = await cleanupStaleBookings();
    await settle();

    expect(db.appointments[0].status).toBe('cancelled');
    expect(db.appointments[0].cancellation_reason).toBe('auto_cancelled_never_payable');
    expect(r.confirmedUnpayable).toBe(0);
    expect(toldClient).toHaveLength(0);
  });

  it('still releases an abandoned checkout at a salon that CAN take payment', async () => {
    db.clients.push({ id: 'c2', beautician_id: 'b_old', first_name: 'Charlotte', phone: '07700900124', email: 'charlotte@example.com', whatsapp_id: null });
    db.appointments.push(legacyPending({
      id: 'a_real', beautician_id: 'b_old', client_id: 'c2',
      deposit_cents: 2000, stripe_payment_intent_id: 'pi_no',
      clients: { first_name: 'Charlotte' },
    }));

    const r = await cleanupStaleBookings();
    await settle();

    expect(r.cancelled).toBe(1);
    expect(db.appointments[0].status).toBe('cancelled');
    expect(db.appointments[0].cancellation_reason).toBe('auto_cancelled_unpaid');
  });
});
