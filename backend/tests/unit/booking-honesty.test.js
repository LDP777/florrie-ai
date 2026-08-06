/**
 * A client is only ever told she is booked in when a row exists that Ellie can
 * see, and a slot is only ever taken away when we can prove nobody paid for it.
 *
 * Three of the ways that was not true on 5 August:
 *
 *  1. When Stripe would not open a Checkout session, the booking route logged
 *     the failure and CARRIED ON into the "no deposit, confirmed immediately"
 *     tail. The client got a full "you're booked in for X at Y", the page drew
 *     a green tick, and the row sat pending with no payment intent, which the
 *     stale cleanup could not tell from an abandoned checkout.
 *  2. A client could reschedule herself onto a closed day. The route validated
 *     the future, the notice period and the diary, selected working_hours, and
 *     then never looked at it.
 *  3. Charlotte's GBP 80 booking was one tap from deletion with no warning,
 *     because every signal the delete guard consulted (deposit_paid, a
 *     transactions row) is written by the webhook that had died.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const db = {
  beauticians: [], treatments: [], clients: [], appointments: [], hours_exceptions: [],
  ai_actions: [], transactions: [], waitlist: [], promo_codes: [], gift_vouchers: [],
};
const failing = new Map();       // table -> PostgREST style error object
const deletes = [];
let idCounter = 0;
const nextId = (p) => `${p}_${++idCounter}`;

function makeBuilder(table) {
  const filters = [];
  let pending = null;
  const matching = () => (db[table] || []).filter(r => filters.every(f => f(r)));
  const settle = () => {
    if (failing.has(table)) return { data: null, error: failing.get(table), count: null };
    if (pending?.op === 'insert') {
      const payload = Array.isArray(pending.payload) ? pending.payload : [pending.payload];
      const created = payload.map(p => ({ id: nextId(table), management_token: nextId('mt'), created_at: new Date().toISOString(), ...p }));
      db[table].push(...created);
      return { data: created, error: null };
    }
    if (pending?.op === 'update') {
      const rows = matching();
      for (const r of rows) Object.assign(r, pending.payload);
      return { data: rows, error: null };
    }
    if (pending?.op === 'delete') {
      const gone = matching();
      deletes.push({ table, ids: gone.map(r => r.id) });
      db[table] = (db[table] || []).filter(r => !filters.every(f => f(r)));
      return { data: gone, error: null };
    }
    return { data: matching(), error: null };
  };
  const b = {
    select() { return b; },
    insert(p) { pending = { op: 'insert', payload: p }; return b; },
    update(p) { pending = { op: 'update', payload: p }; return b; },
    delete() { pending = { op: 'delete' }; return b; },
    eq(c, v) { filters.push(r => r[c] === v); return b; },
    neq(c, v) { filters.push(r => r[c] !== v); return b; },
    in(c, v) { filters.push(r => v.includes(r[c])); return b; },
    is(c, v) { filters.push(r => (r[c] ?? null) === v); return b; },
    or() { return b; },
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
    // Real PostgREST builders are full thenables; a couple of call sites hang
    // a .catch() straight off one, so the fake has to as well.
    catch(rej) { return Promise.resolve(settle()).catch(rej); },
  };
  return b;
}

vi.mock('../../src/config.js', () => ({ supabase: { from: (t) => makeBuilder(t) } }));

// Stripe: checkout can be told to fall over, and each payment intent has a status.
const stripeState = { checkoutThrows: false, sessions: [], piStatus: new Map() };
vi.mock('stripe', () => ({
  default: class {
    constructor() {
      this.customers = { create: async () => ({ id: 'cus_fake' }) };
      this.checkout = { sessions: { create: async (args) => {
        if (stripeState.checkoutThrows) throw new Error('Stripe is down');
        stripeState.sessions.push(args);
        return { id: 'cs_fake', url: 'https://checkout.stripe.com/c/pay/cs_fake', payment_intent: 'pi_fake' };
      } } };
      this.paymentIntents = { retrieve: async (id) => {
        const st = stripeState.piStatus.get(id);
        if (st === 'THROW') throw new Error('stripe unreachable');
        return { id, status: st || 'requires_payment_method' };
      } };
      this.events = { list: async () => ({ data: [] }) };
    }
  },
}));

const told = { confirmed: [], moved: [] };
vi.mock('../../src/services/notifications.js', () => ({
  notifyBookingConfirmed: async (id) => { told.confirmed.push(id); return true; },
  sendMessage: async () => ({ channel: 'sms' }),
  sendWhatsApp: async () => true,
  sendSMS: async () => true,
  sendEmail: async () => true,
  pickChannel: () => 'sms',
}));
vi.mock('../../src/services/push-notifications.js', () => ({
  pushNewBooking: async () => true, pushBookingConfirmed: async () => true,
  pushReschedule: async () => true, pushPatchTestBooked: async () => true,
  pushClientCancelled: async () => true, pushTeamUpdate: async () => true,
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
vi.mock('../../src/lib/outbound-guard.js', () => ({
  guardedSend: async ({ send }) => ({ decision: 'send', delivered: !!(await send()) }),
}));
vi.mock('../../src/services/client-intelligence.js', () => ({ updateClientIntelligence: async () => true }));
vi.mock('../../src/services/email-sequences.js', () => ({ triggerSequence: async () => true }));
vi.mock('../../src/services/review-requests.js', () => ({ scheduleReviewRequest: async () => true }));
vi.mock('../../src/services/loyalty.js', () => ({ awardLoyaltyPoints: async () => true }));
vi.mock('../../src/lib/takings.js', () => ({ logAssumedTakings: async () => true }));
vi.mock('@sentry/node', () => ({ captureMessage: () => {}, captureException: () => {} }));

process.env.STRIPE_SECRET_KEY = 'sk_test_x';
process.env.FRONTEND_URL = 'https://florrie.ai';

const bookingRouter = (await import('../../src/routes/booking.js')).default;
const appointmentsRouter = (await import('../../src/routes/appointments.js')).default;

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
// Six days a week, which is the shape that matters: Sunday is her day off.
const SIX_DAYS = { ...ALL_WEEK, sun: undefined };

/** The next dated weekday at 11:00, wall time, comfortably inside the horizon. */
function nextWeekday(targetDow, weeksAhead = 3) {
  const d = new Date(Date.now() + weeksAhead * 7 * 24 * 60 * 60 * 1000);
  d.setUTCHours(11, 0, 0, 0);
  while (d.getUTCDay() !== targetDow) d.setUTCDate(d.getUTCDate() + 1);
  return `${d.toISOString().slice(0, 16)}:00`;
}

beforeEach(() => {
  for (const t of Object.keys(db)) db[t] = [];
  failing.clear();
  deletes.length = 0;
  told.confirmed.length = 0;
  stripeState.checkoutThrows = false;
  stripeState.sessions.length = 0;
  stripeState.piStatus.clear();
  db.beauticians.push({
    id: 'b1', booking_slug: 'ellindigo', business_name: 'Ellindigo', first_name: 'Ellie',
    stripe_account_id: 'acct_1', stripe_onboarding_complete: true,
    booking_policy: {}, payment_settings: {}, working_hours: ALL_WEEK,
    client_reminder_prefs: {},
  });
  db.treatments.push({
    id: 't1', beautician_id: 'b1', name: 'Hybrid stain', duration_minutes: 60,
    buffer_minutes: 0, price_cents: 8000, deposit_cents: 2000, deposit_percent: null,
    requires_patch_test: false, requires_consultation: false, consultation_form_id: null,
  });
});

const bookBody = (over = {}) => ({
  treatment_id: 't1',
  starts_at: nextWeekday(3),        // a Wednesday, inside opening hours
  client_name: 'Charlotte Scott',
  client_email: 'charlotte@example.com',
  client_phone: '07700900123',
  payment_type: 'deposit',
  ...over,
});

describe('a failed checkout must not tell the client she is booked', () => {
  it('releases the hold and returns an honest error when Stripe will not open a session', async () => {
    stripeState.checkoutThrows = true;

    const out = await run(bookingRouter, 'post', '/:slug/book', {
      params: { slug: 'ellindigo' }, body: bookBody(),
    });

    // Not a 201, and nothing in the response a booking page could draw a tick from.
    expect(out.status).toBe(502);
    expect(out.body.booking).toBeUndefined();
    expect(out.body.checkout_url).toBeUndefined();

    // She was NOT told she is booked in.
    expect(told.confirmed, 'the client was sent a booking confirmation').toHaveLength(0);

    // And the slot went back in the diary rather than sitting pending forever.
    expect(db.appointments).toHaveLength(1);
    expect(db.appointments[0].status).toBe('cancelled');
    expect(db.appointments[0].cancellation_reason).toBe('checkout_creation_failed');
  });

  it('still books normally when Stripe behaves, pending and unconfirmed until the money lands', async () => {
    const out = await run(bookingRouter, 'post', '/:slug/book', {
      params: { slug: 'ellindigo' }, body: bookBody(),
    });

    expect(out.status).toBe(201);
    expect(out.body.checkout_url).toContain('checkout.stripe.com');
    expect(db.appointments[0].status).toBe('pending');
    expect(db.appointments[0].stripe_payment_intent_id).toBe('pi_fake');
    // A deposit booking is not confirmed by this route, whatever happens.
    expect(told.confirmed).toHaveLength(0);
  });
});

describe('a client cannot move herself into a day the salon is shut', () => {
  const seedAppointment = (over = {}) => {
    const appt = {
      id: 'a1', beautician_id: 'b1', client_id: 'c1', management_token: 'mt1',
      status: 'confirmed', duration_minutes: 60, buffer_minutes: 0, extra_padding_minutes: 0,
      starts_at: nextWeekday(3, 2), ends_at: nextWeekday(3, 2), policy_snapshot: {},
      client_email: 'charlotte@example.com', treatment_id: 't1', rescheduled_at: null,
      beauticians: {
        id: 'b1', booking_slug: 'ellindigo', booking_policy: {}, business_name: 'Ellindigo',
        first_name: 'Ellie', working_hours: SIX_DAYS,
      },
      treatments: { name: 'Hybrid stain' },
      clients: { first_name: 'Charlotte', email: 'charlotte@example.com' },
      ...over,
    };
    db.appointments.push(appt);
    return appt;
  };

  it('refuses a move onto her day off', async () => {
    const appt = seedAppointment();
    const sunday = nextWeekday(0);

    const out = await run(bookingRouter, 'post', '/:slug/manage/:token/reschedule', {
      params: { slug: 'ellindigo', token: 'mt1' }, body: { new_starts_at: `${sunday}.000Z` },
    });

    expect(out.status).toBe(409);
    expect(out.body.error).toMatch(/closed that day/i);
    expect(appt.starts_at, 'the booking moved anyway').not.toContain(sunday.slice(0, 10));
  });

  it('refuses a move into a day she has blocked out', async () => {
    const appt = seedAppointment();
    const target = nextWeekday(4);
    db.hours_exceptions.push({ beautician_id: 'b1', date: target.slice(0, 10), type: 'closed', start_time: null, end_time: null });

    const out = await run(bookingRouter, 'post', '/:slug/manage/:token/reschedule', {
      params: { slug: 'ellindigo', token: 'mt1' }, body: { new_starts_at: `${target}.000Z` },
    });

    expect(out.status).toBe(409);
    expect(appt.starts_at).not.toContain(target.slice(0, 10));
  });

  it('refuses a move to a time after closing', async () => {
    seedAppointment();
    const late = `${nextWeekday(4).slice(0, 11)}19:00:00`;

    const out = await run(bookingRouter, 'post', '/:slug/manage/:token/reschedule', {
      params: { slug: 'ellindigo', token: 'mt1' }, body: { new_starts_at: `${late}.000Z` },
    });

    expect(out.status).toBe(409);
    expect(out.body.error).toMatch(/opening hours/i);
  });

  it('still allows a perfectly ordinary move to a working day', async () => {
    const appt = seedAppointment();
    const target = nextWeekday(4);

    const out = await run(bookingRouter, 'post', '/:slug/manage/:token/reschedule', {
      params: { slug: 'ellindigo', token: 'mt1' }, body: { new_starts_at: `${target}.000Z` },
    });

    expect(out.status).toBe(200);
    expect(out.body.success).toBe(true);
    expect(appt.starts_at).toContain(target.slice(0, 10));
  });
});

describe("deleting a booking somebody may have paid for", () => {
  const seedPaid = (over = {}) => {
    db.appointments.push({
      id: 'a1', beautician_id: 'b1', client_id: 'c1', status: 'confirmed',
      // Exactly Charlotte's row on 5 August: paid in full, and every column
      // that would say so is written by a webhook that never fired.
      deposit_paid: false, deposit_cents: 8000, policy_fee_charged_at: null,
      starts_at: nextWeekday(3, 1), stripe_payment_intent_id: 'pi_charlotte',
      ...over,
    });
  };

  it('refuses when Stripe says the payment intent succeeded, however our own columns read', async () => {
    seedPaid();
    stripeState.piStatus.set('pi_charlotte', 'succeeded');

    const out = await run(appointmentsRouter, 'delete', '/:id', {
      params: { id: 'a1' }, beautician: { id: 'b1' },
    });

    expect(out.status).toBe(409);
    expect(out.body.code).toBe('has_payment');
    expect(out.body.requires_confirmation).toBe(true);
    expect(db.appointments).toHaveLength(1);
    expect(deletes.filter(d => d.table === 'appointments')).toHaveLength(0);
  });

  it('refuses when Stripe cannot say either way, because unknown is not the same as unpaid', async () => {
    seedPaid();
    stripeState.piStatus.set('pi_charlotte', 'THROW');

    const out = await run(appointmentsRouter, 'delete', '/:id', {
      params: { id: 'a1' }, beautician: { id: 'b1' },
    });

    expect(out.status).toBe(409);
    expect(db.appointments).toHaveLength(1);
  });

  it('refuses outright when the payments table cannot be read, rather than reading it as empty', async () => {
    seedPaid({ stripe_payment_intent_id: null });
    failing.set('transactions', { message: 'connection reset', code: '08006' });

    const out = await run(appointmentsRouter, 'delete', '/:id', {
      params: { id: 'a1' }, beautician: { id: 'b1' },
    });

    expect(out.status).toBe(503);
    expect(db.appointments).toHaveLength(1);
  });

  it('still deletes a genuine mis-entry that Stripe confirms was never paid', async () => {
    seedPaid();
    stripeState.piStatus.set('pi_charlotte', 'requires_payment_method');

    const out = await run(appointmentsRouter, 'delete', '/:id', {
      params: { id: 'a1' }, beautician: { id: 'b1' },
    });

    expect(out.status).toBe(200);
    expect(out.body.success).toBe(true);
    expect(db.appointments).toHaveLength(0);
  });
});
