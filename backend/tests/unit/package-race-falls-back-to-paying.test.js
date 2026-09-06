/**
 * THE LAST SESSION OF A COURSE, SPENT ON ANOTHER DEVICE.
 *
 * `check-packages` was broken for the whole life of the feature: it asked for
 * `packages.sessions`, the column is sessions_total, PostgREST rejected the
 * whole select and every client was told she had no packages. That is fixed,
 * so from now on the booking page really does offer "use a session from your
 * course" and really does send client_package_id back.
 *
 * Which makes the new 409 underneath it reachable for the first time. She
 * loads the page with one session left, her partner books that session on her
 * phone, she taps confirm, and a booking that used to complete as an ordinary
 * paid booking now dies on "That package has no sessions left on it." She has
 * her card out and a slot in front of her; the honest answer is a bill, not a
 * refusal. Before any of this, an exhausted package simply fell through and
 * she paid.
 *
 * The exception is a package that is not hers. That is not a race, it is an id
 * from somewhere it should not have come from, and it stays a hard refusal.
 *
 * And the expiry: client_packages.expires_at has been a real column since
 * 007_all_features.sql:104 and nothing has ever read it, so a course that ran
 * out of time in March still hands out free sessions today.
 */
process.env.TZ = 'UTC';

import { describe, it, expect, beforeEach, vi } from 'vitest';

/* ------------------------------------------------------------------ schema --
 * Columns copied from supabase/migrations, so a select naming something that
 * does not exist fails here the way it fails in production.
 */
const COLUMNS = {
  packages: [
    'id', 'beautician_id', 'name', 'description', 'treatment_ids',
    'sessions_total', 'price_cents', 'saving_cents', 'validity_days',
    'is_active', 'created_at', 'updated_at',
  ],
  client_packages: [
    'id', 'beautician_id', 'client_id', 'package_id', 'sessions_used',
    'sessions_total', 'purchased_at', 'expires_at', 'status', 'created_at',
  ],
};

const RELATIONS = {
  client_packages: { packages: { table: 'packages', fk: 'package_id' } },
};

const db = {
  beauticians: [], treatments: [], clients: [], appointments: [],
  hours_exceptions: [], gift_vouchers: [], promo_codes: [], packages: [],
  client_packages: [], waitlist: [], outbound_sends: [], ai_actions: [],
  transactions: [], appointment_add_ons: [], add_ons: [], patch_tests: [],
  consultation_responses: [], notifications: [], memberships: [],
};
const failing = new Map();
let idCounter = 0;
const nextId = (p) => `${p}_${++idCounter}`;

/** Split "a, b(c, d), e" on top-level commas only. */
function splitTop(spec) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of String(spec)) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map(s => s.trim()).filter(Boolean);
}

const undefinedColumn = (table, col) => ({
  code: '42703', message: `column ${table}.${col} does not exist`, details: null, hint: null,
});

function parseSelect(table, spec) {
  const embeds = [];
  if (!spec || spec === '*') return { error: null, embeds };
  for (const item of splitTop(spec)) {
    const nested = /^([\w]+)\s*\(([\s\S]*)\)$/.exec(item);
    if (nested) {
      const [, rel, inner] = nested;
      embeds.push(rel);
      const known = COLUMNS[rel];
      if (known) {
        for (const c of splitTop(inner)) {
          const col = c.includes(':') ? c.split(':').pop().trim() : c;
          if (col !== '*' && !known.includes(col)) return { error: undefinedColumn(rel, col), embeds };
        }
      }
      continue;
    }
    const known = COLUMNS[table];
    if (!known) continue;
    const col = item.includes(':') ? item.split(':').pop().trim() : item;
    if (col === '*') continue;
    if (!known.includes(col)) return { error: undefinedColumn(table, col), embeds };
  }
  return { error: null, embeds };
}

function makeBuilder(table) {
  const filters = [];
  let pending = null;
  let embeds = [];
  let selectError = null;
  let wantCount = false;

  const matching = () => (db[table] || []).filter(r => filters.every(f => f(r)));

  const withEmbeds = (rows) => rows.map((r) => {
    const out = { ...r };
    for (const rel of embeds) {
      if (out[rel] !== undefined) continue;
      const cfg = RELATIONS[table]?.[rel];
      if (!cfg) continue;
      out[rel] = (db[cfg.table] || []).find(x => x.id === r[cfg.fk]) || null;
    }
    return out;
  });

  const settle = () => {
    if (pending?.op === 'insert' && failing.has(table + ':insert')) return { data: null, error: failing.get(table + ':insert') };
    if (failing.has(table)) return { data: null, error: failing.get(table), count: null };
    if (selectError) return { data: null, error: selectError, count: null };
    if (pending?.op === 'insert') {
      const payload = Array.isArray(pending.payload) ? pending.payload : [pending.payload];
      const created = payload.map(p => ({
        id: nextId(table), management_token: nextId('mt'),
        created_at: new Date().toISOString(), ...p,
      }));
      db[table].push(...created);
      return { data: created, error: null, count: created.length };
    }
    if (pending?.op === 'update') {
      const rows = matching();
      for (const r of rows) Object.assign(r, pending.payload);
      return { data: rows, error: null, count: rows.length };
    }
    if (pending?.op === 'delete') {
      const gone = matching();
      db[table] = (db[table] || []).filter(r => !filters.every(f => f(r)));
      return { data: gone, error: null, count: gone.length };
    }
    const rows = matching();
    if (wantCount) return { data: [], error: null, count: rows.length };
    return { data: withEmbeds(rows), error: null, count: rows.length };
  };

  const b = {
    select(spec = '*', opts) {
      wantCount = opts?.count === 'exact';
      const parsed = parseSelect(table, spec);
      selectError = parsed.error;
      embeds = parsed.embeds;
      return b;
    },
    insert(p) { pending = { op: 'insert', payload: p }; return b; },
    update(p) { pending = { op: 'update', payload: p }; return b; },
    delete() { pending = { op: 'delete' }; return b; },
    eq(c, v) { filters.push(r => r[c] === v); return b; },
    neq(c, v) { filters.push(r => r[c] !== v); return b; },
    in(c, v) { filters.push(r => v.includes(r[c])); return b; },
    is(c, v) { filters.push(r => (r[c] ?? null) === v); return b; },
    or() { return b; },
    not(c, op, v) {
      if (op === 'in') {
        const list = String(v).replace(/[()]/g, '').split(',');
        filters.push(r => !list.includes(String(r[c])));
      } else filters.push(r => (r[c] ?? null) !== null);
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

vi.mock('../../src/config.js', () => ({ supabase: { from: (t) => makeBuilder(t), rpc: (name, { p_booking }) => ({ single: async () => {
  if (name !== 'create_package_booking') throw new Error('unexpected RPC');
  const result = await makeBuilder('appointments').insert(p_booking).single();
  if (!result.error) {
    const cp = db.client_packages.find(p => p.id === p_booking.client_package_id);
    cp.sessions_used += 1;
    if (cp.sessions_used >= cp.sessions_total) cp.status = 'completed';
  }
  return result;
} }) } }));

/* ------------------------------------------------------------------- mocks -- */
const stripeState = { sessions: [] };
vi.mock('stripe', () => ({
  default: class {
    constructor() {
      this.customers = { create: async () => ({ id: 'cus_fake' }) };
      this.checkout = { sessions: { create: async (args) => {
        stripeState.sessions.push(args);
        return { id: 'cs_fake', url: 'https://checkout.stripe.com/c/pay/cs_fake', payment_intent: 'pi_fake' };
      } } };
      this.paymentIntents = { retrieve: async (id) => ({ id, status: 'succeeded' }) };
      this.events = { list: async () => ({ data: [] }) };
    }
  },
}));

vi.mock('../../src/services/notifications.js', () => ({
  notifyBookingConfirmed: async () => true,
  sendMessage: async () => ({ channel: 'sms' }),
  sendWhatsApp: async () => true,
  sendSMS: async () => ({ channel: 'sms' }),
  sendEmail: async () => ({ id: 'em_1' }),
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
vi.mock('../../src/middleware/turnstile.js', () => ({ verifyTurnstile: (_q, _s, next) => next() }));
vi.mock('../../src/middleware/auth.js', () => ({ requireAuth: (_q, _s, next) => next() }));
vi.mock('../../src/services/outstanding-balance.js', () => ({ getOutstandingBalanceCents: async () => ({ owesCents: 0 }) }));
vi.mock('../../src/lib/client-archive.js', () => ({ autoUnarchiveClient: async () => true }));
vi.mock('../../src/services/client-intelligence.js', () => ({ updateClientIntelligence: async () => true }));
vi.mock('../../src/services/email-sequences.js', () => ({ triggerSequence: async () => true }));
vi.mock('../../src/services/review-requests.js', () => ({ scheduleReviewRequest: async () => true }));
vi.mock('../../src/services/loyalty.js', () => ({ awardLoyaltyPoints: async () => true }));
vi.mock('../../src/lib/takings.js', () => ({ logAssumedTakings: async () => true }));
vi.mock('@sentry/node', () => ({ captureMessage: () => {}, captureException: () => {} }));
vi.mock('../../src/services/whatsapp-metering.js', () => ({
  getMonthlyUsage: async () => null,
  checkWhatsAppQuota: async () => ({ allowed: true }),
  trackWhatsAppMessage: async () => true,
  trackSmsInMonthlyQuota: async () => true,
}));
vi.mock('../../src/lib/marketing-guard.js', () => ({
  inMarketingQuietHours: () => false,
  isMarketingTemplate: () => false,
  isMarketingSmsType: () => false,
  canSendMarketing: async () => ({ allowed: true }),
  findClientByPhone: async () => null,
}));

process.env.STRIPE_SECRET_KEY = 'sk_test_x';
process.env.FRONTEND_URL = 'https://florrie.ai';

const bookingRouter = (await import('../../src/routes/booking.js')).default;

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
  await handler({ headers: {}, get: () => 'api.florrie.ai', query: {}, body: {}, params: {}, beautician: { id: 'b1' }, ...req }, res);
  return out;
}

const ALL_WEEK = {
  mon: { start: '09:00', end: '18:00' }, tue: { start: '09:00', end: '18:00' },
  wed: { start: '09:00', end: '18:00' }, thu: { start: '09:00', end: '18:00' },
  fri: { start: '09:00', end: '18:00' }, sat: { start: '09:00', end: '18:00' },
  sun: { start: '09:00', end: '18:00' },
};

/** A dated weekday at 11:00, wall time, comfortably inside the horizon. */
function nextWeekday(targetDow, weeksAhead = 3) {
  const d = new Date(Date.now() + weeksAhead * 7 * 24 * 60 * 60 * 1000);
  d.setUTCHours(11, 0, 0, 0);
  while (d.getUTCDay() !== targetDow) d.setUTCDate(d.getUTCDate() + 1);
  return `${d.toISOString().slice(0, 16)}:00`;
}

beforeEach(() => {
  for (const t of Object.keys(db)) db[t] = [];
  failing.clear();
  idCounter = 0;
  stripeState.sessions.length = 0;
  db.beauticians.push({
    id: 'b1', booking_slug: 'ellindigo', business_name: 'Ellindigo', first_name: 'Ellie',
    timezone: 'Europe/London', stripe_account_id: 'acct_1', stripe_onboarding_complete: true,
    booking_policy: {}, payment_settings: {}, working_hours: ALL_WEEK,
    client_reminder_prefs: {}, autonomy: { proactive: 'auto' },
  });
  db.treatments.push({
    id: 't1', beautician_id: 'b1', name: 'Hybrid stain', duration_minutes: 60,
    buffer_minutes: 0, price_cents: 8000, deposit_cents: 2000, deposit_percent: null,
    requires_patch_test: false, requires_consultation: false, consultation_form_id: null,
  });
  db.clients.push({
    id: 'c1', beautician_id: 'b1', first_name: 'Charlotte', last_name: 'Scott',
    email: 'charlotte@example.com', phone: '07700900123', blocked_at: null, archived_at: null,
    stripe_customer_id: null, marketing_consent: true, marketing_opted_out_at: null,
    messaging_autonomy: null,
  });
});

const bookBody = (over = {}) => ({
  treatment_id: 't1',
  starts_at: nextWeekday(3),
  client_name: 'Charlotte Scott',
  client_email: 'charlotte@example.com',
  client_phone: '07700900123',
  payment_type: 'deposit',
  ...over,
});

const sixPack = (over = {}) => {
  db.packages.push({
    id: 'p1', beautician_id: 'b1', name: 'Six lash lifts', sessions_total: 6,
    treatment_ids: ['t1'], price_cents: 40000, is_active: true,
  });
  db.client_packages.push({
    id: 'cp1', beautician_id: 'b1', client_id: 'c1', package_id: 'p1',
    sessions_used: 2, sessions_total: 6, status: 'active', expires_at: null, ...over,
  });
};

const daysFromNow = (n) => new Date(Date.now() + n * 86400000).toISOString();

/* ================================================= the race, and the fallback */
describe('a package that ran out between the page loading and the tap', () => {
  it('takes the booking and charges for it rather than refusing it', async () => {
    // Her last session went on another device thirty seconds ago.
    sixPack({ sessions_used: 6 });

    const out = await run(bookingRouter, 'post', '/:slug/book', {
      params: { slug: 'ellindigo' }, body: bookBody({ client_package_id: 'cp1' }),
    });

    expect(out.status, 'a payable booking was turned into an error message').toBe(201);
    expect(db.appointments, 'nothing was booked at all').toHaveLength(1);
    // Paid, not redeemed: she is going to Stripe for the deposit.
    expect(db.appointments[0].package_redemption).toBeFalsy();
    expect(stripeState.sessions).toHaveLength(1);
    expect(out.body.checkout_url).toBeTruthy();
  });

  it('tells her why she is being asked to pay', async () => {
    sixPack({ sessions_used: 6 });
    const out = await run(bookingRouter, 'post', '/:slug/book', {
      params: { slug: 'ellindigo' }, body: bookBody({ client_package_id: 'cp1' }),
    });
    expect(out.body.package_note).toMatch(/not available/i);
  });

  it('does the same for a package id that is not there any more', async () => {
    // Cancelled, or refunded, or simply gone. Same answer: she can still book.
    const out = await run(bookingRouter, 'post', '/:slug/book', {
      params: { slug: 'ellindigo' }, body: bookBody({ client_package_id: 'cp-vanished' }),
    });

    expect(out.status).toBe(201);
    expect(db.appointments).toHaveLength(1);
    expect(db.appointments[0].package_redemption).toBeFalsy();
  });

  it('still redeems a package that IS good, free, with no Stripe', async () => {
    sixPack();
    const out = await run(bookingRouter, 'post', '/:slug/book', {
      params: { slug: 'ellindigo' }, body: bookBody({ client_package_id: 'cp1' }),
    });

    expect(out.status).toBe(201);
    expect(stripeState.sessions).toHaveLength(0);
    expect(db.client_packages[0].sessions_used).toBe(3);
    expect(out.body.package_note).toBeUndefined();
  });

  it('does not spend a session when the appointment insert loses the slot race', async () => {
    sixPack();
    failing.set('appointments:insert', { code: '23P01', message: 'slot occupied' });
    const out = await run(bookingRouter, 'post', '/:slug/book', {
      params: { slug: 'ellindigo' }, body: bookBody({ client_package_id: 'cp1' }),
    });
    expect(out.status).toBe(409);
    expect(db.client_packages[0].sessions_used).toBe(2);
    expect(db.appointments).toHaveLength(0);
  });

  it('refuses a package for a treatment outside its catalogue', async () => {
    sixPack(); db.packages[0].treatment_ids = ['another-treatment'];
    const out = await run(bookingRouter, 'post', '/:slug/book', {
      params: { slug: 'ellindigo' }, body: bookBody({ client_package_id: 'cp1' }),
    });
    expect(out.status).toBe(409);
    expect(out.body.code).toBe('package_treatment_not_covered');
    expect(db.client_packages[0].sessions_used).toBe(2);
    expect(db.appointments).toHaveLength(0);
  });

  it('still refuses a package belonging to somebody else, and spends nothing', async () => {
    // The one case that is not a race. An id from another account is not a
    // booking problem, and paying for it quietly would hide it.
    sixPack({ client_id: 'c-someone-else' });

    const out = await run(bookingRouter, 'post', '/:slug/book', {
      params: { slug: 'ellindigo' }, body: bookBody({ client_package_id: 'cp1' }),
    });

    expect(out.status).toBe(409);
    expect(out.body.error).toMatch(/not on your account/i);
    expect(db.client_packages[0].sessions_used).toBe(2);
    expect(db.appointments).toHaveLength(0);
  });

  it('still refuses when the package cannot be verified at all', async () => {
    // Falling back to paying is for a package we looked at and cannot use. A
    // lookup that failed tells us nothing, and charging her then is the bug
    // this route already refuses to commit.
    sixPack();
    failing.set('client_packages', { code: '08006', message: 'connection failed' });

    const out = await run(bookingRouter, 'post', '/:slug/book', {
      params: { slug: 'ellindigo' }, body: bookBody({ client_package_id: 'cp1' }),
    });

    expect(out.status).toBe(503);
    expect(db.appointments).toHaveLength(0);
  });
});

/* ============================================================== the expiry == */
describe('client_packages.expires_at, a column nothing has ever read', () => {
  it('does not hand out a free session on a course that ran out of time', async () => {
    sixPack({ expires_at: daysFromNow(-30) });

    const out = await run(bookingRouter, 'post', '/:slug/book', {
      params: { slug: 'ellindigo' }, body: bookBody({ client_package_id: 'cp1' }),
    });

    expect(out.status).toBe(201);
    expect(db.client_packages[0].sessions_used, 'an expired package still paid for a session').toBe(2);
    expect(stripeState.sessions).toHaveLength(1);
  });

  it('does not offer an expired package on the booking page either', async () => {
    sixPack({ expires_at: daysFromNow(-1) });

    const out = await run(bookingRouter, 'post', '/:slug/check-packages', {
      params: { slug: 'ellindigo' }, body: { phone: '07700900123', treatment_id: 't1' },
    });

    expect(out.body.packages).toHaveLength(0);
  });

  it('still offers one that is in date', async () => {
    sixPack({ expires_at: daysFromNow(30) });

    const out = await run(bookingRouter, 'post', '/:slug/check-packages', {
      params: { slug: 'ellindigo' }, body: { phone: '07700900123', treatment_id: 't1' },
    });

    expect(out.body.packages).toHaveLength(1);
    expect(out.body.packages[0].sessions_remaining).toBe(4);
  });

  it('treats no expiry date as no expiry', async () => {
    sixPack({ expires_at: null });
    const out = await run(bookingRouter, 'post', '/:slug/book', {
      params: { slug: 'ellindigo' }, body: bookBody({ client_package_id: 'cp1' }),
    });
    expect(out.status).toBe(201);
    expect(db.client_packages[0].sessions_used).toBe(3);
  });
});
