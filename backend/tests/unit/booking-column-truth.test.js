/**
 * FOUR WAYS A QUERY THAT NEVER RAN LOOKED EXACTLY LIKE AN EMPTY ANSWER.
 *
 * PostgREST rejects the WHOLE select if one column in it does not exist, and it
 * reports that by RESOLVING with { data: null, error }, not by throwing. So a
 * select naming a column nobody ever created, whose `error` is not read, is
 * indistinguishable at the call site from "there is nothing there":
 *
 *   gift_vouchers.amount        does not exist. It is amount_cents / remaining_cents.
 *                               A client was told her voucher was not recognised
 *                               and paid the full price for it.
 *   packages.sessions           does not exist. It is sessions_total.
 *                               A client with a paid 6-session package was sent
 *                               to Stripe and charged for the session again.
 *   waitlist.phone/first_name/  do not exist. The table is client_id + treatment
 *   preferred_times             + preferences; contact details live on clients.
 *                               Nobody has ever been told a slot opened up.
 *
 * The fake Supabase below therefore does what the real one does: it knows the
 * columns of the tables these bugs live in (taken from supabase/migrations) and
 * refuses a select that names anything else. That is the whole point. A stub
 * that hands back rows whatever you ask for cannot fail on any of this, which
 * is why 861 passing tests never saw it.
 *
 * Two more, same file because they are the same booking:
 *   - hours_exceptions is a RANGE (date..end_date). Every reader matched on
 *     `date` alone, so blocking 24 to 30 August closed the 24th and sold the
 *     rest of the holiday.
 *   - the past-booking guard compared a WALL time against a real instant, so at
 *     10:00 BST a 09:30 wall slot was still "in the future".
 */
process.env.TZ = 'UTC';   // what src/index.js pins in production, and why.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/* ------------------------------------------------------------------ schema --
 * Column lists copied from supabase/migrations. Only the tables these defects
 * live in are enforced; everything else passes through, so this file fails for
 * these bugs and nothing else.
 */
const COLUMNS = {
  gift_vouchers: [
    'id', 'beautician_id', 'code', 'amount_cents', 'remaining_cents',
    'purchaser_name', 'purchaser_email', 'recipient_name', 'recipient_email',
    'message', 'status', 'purchased_at', 'expires_at', 'redeemed_at',
    'redeemed_by', 'created_at',
  ],
  packages: [
    'id', 'beautician_id', 'name', 'description', 'treatment_ids',
    'sessions_total', 'price_cents', 'saving_cents', 'validity_days',
    'is_active', 'created_at', 'updated_at',
  ],
  client_packages: [
    'id', 'beautician_id', 'client_id', 'package_id', 'sessions_used',
    'sessions_total', 'purchased_at', 'expires_at', 'status', 'created_at',
  ],
  waitlist: [
    'id', 'beautician_id', 'client_id', 'treatment_id', 'preferred_days',
    'preferred_time_start', 'preferred_time_end', 'status', 'offered_at',
    'responded_at', 'priority_score', 'created_at', 'expires_at',
    // 070_waitlist_pro_columns.sql
    'priority', 'notes', 'notify_count', 'notified_at', 'last_notified_at',
    'deposit_held', 'deposit_amount_cents', 'max_wait_days', 'preferred_time',
    'offer_expires_at',
  ],
  hours_exceptions: [
    'id', 'beautician_id', 'date', 'is_closed', 'custom_start', 'custom_end',
    'reason', 'created_at',
    // 008_hours_exceptions_updates.sql, 027_multi_location.sql
    'type', 'end_date', 'start_time', 'end_time', 'note', 'notify_clients',
    'location_id',
  ],
};

// Embedded resources: client_packages -> packages, waitlist -> clients.
const RELATIONS = {
  client_packages: { packages: { table: 'packages', fk: 'package_id' } },
  waitlist: { clients: { table: 'clients', fk: 'client_id' } },
};

const db = {
  beauticians: [], treatments: [], clients: [], appointments: [],
  hours_exceptions: [], gift_vouchers: [], promo_codes: [], packages: [],
  client_packages: [], waitlist: [], outbound_sends: [], ai_actions: [],
  transactions: [], appointment_add_ons: [], add_ons: [], patch_tests: [],
  consultation_responses: [], notifications: [], memberships: [],
};
const failing = new Map();      // table -> PostgREST style error
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
  code: '42703',
  message: `column ${table}.${col} does not exist`,
  details: null,
  hint: null,
});

/**
 * What PostgREST does with a select: validate every column named, and reject
 * the whole request if any one of them is unknown. Returns an error object or
 * null, plus the embedded resources to attach.
 */
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
  let selectSpec = '*';
  let embeds = [];
  let selectError = null;
  let wantCount = false;

  const matching = () => (db[table] || []).filter(r => filters.every(f => f(r)));

  const withEmbeds = (rows) => rows.map((r) => {
    const out = { ...r };
    for (const rel of embeds) {
      if (out[rel] !== undefined) continue;              // seeded inline
      const cfg = RELATIONS[table]?.[rel];
      if (!cfg) continue;
      out[rel] = (db[cfg.table] || []).find(x => x.id === r[cfg.fk]) || null;
    }
    return out;
  });

  const settle = () => {
    if (failing.has(table)) return { data: null, error: failing.get(table), count: null };
    if (selectError) return { data: null, error: selectError, count: null };
    if (pending?.op === 'insert') {
      const payload = Array.isArray(pending.payload) ? pending.payload : [pending.payload];
      const created = payload.map(p => ({ id: nextId(table), management_token: nextId('mt'), created_at: new Date().toISOString(), ...p }));
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
      selectSpec = spec;
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

const sent = { sms: [], email: [] };
vi.mock('../../src/services/notifications.js', () => ({
  notifyBookingConfirmed: async () => true,
  sendMessage: async () => ({ channel: 'sms' }),
  sendWhatsApp: async () => true,
  sendSMS: async (args) => { sent.sms.push(args); return { channel: 'sms' }; },
  sendEmail: async (args) => { sent.email.push(args); return { id: 'em_1' }; },
  pickChannel: () => 'sms',
}));
vi.mock('../../src/services/push-notifications.js', () => ({
  pushNewBooking: async () => true, pushBookingConfirmed: async () => true,
  pushReschedule: async () => true, pushPatchTestBooked: async () => true,
  pushClientCancelled: async () => true, pushTeamUpdate: async () => true,
}));
vi.mock('../../src/services/live-activity.js', () => ({ refreshLiveActivity: async () => true }));
/* RECORDED, NOT SWALLOWED.
 *
 * These two used to return `true` and `{}` and nothing ever looked at them, so
 * no test in this suite could see whether a consultation form was sent or
 * whether a client's answers were filed anywhere. That is how the booking page
 * came to decide who needed the health questions from
 * `recognisedClient?.found` and wave through all 926 clients imported from
 * Timely, 277 of whom have never once been in, without a single test noticing.
 * The rule itself is pinned in tests/unit/consultation-gate.test.js; these
 * arrays are so this file can no longer be blind to it. */
const consultation = { sent: [], filed: [] };
vi.mock('../../src/routes/consultation-forms.js', () => ({
  sendConsultationFormSMS: async (args) => { consultation.sent.push(args); return { id: 'cr_1' }; },
  recordBookingConsultation: async (args) => { consultation.filed.push(args); return { unrecorded: {}, failed: false }; },
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

// The REAL outbound guard runs here: that is the half of defect D that matters.
// Only its two outside dependencies are pinned, so the test does not depend on
// what time of day it happens to run.
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
const hoursRouter = (await import('../../src/routes/hours-exceptions.js')).default;
const { loadBlocks, getFreeSlots } = await import('../../src/lib/free-slots.js');

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

/** Let the fire-and-forget tails (the waitlist notifier) actually run. */
const settleBackground = () => new Promise(r => setTimeout(r, 0));

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
  sent.sms.length = 0;
  sent.email.length = 0;
  consultation.sent.length = 0;
  consultation.filed.length = 0;
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

/* ============================================================== A. closures == */

describe('a closure is a range, not the first day of one', () => {
  /* The dates below are fixed, so the clock has to be too. Run this file on the
   * 27th of August with a real clock and the booking under test is refused for
   * being in the past, which is a 400, and the holiday guard it exists to prove
   * is never reached. A test that reads the wall clock fixes the wall clock. */
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-20T09:00:00.000Z'));
  });
  afterEach(() => { vi.useRealTimers(); });

  // Ellie blocks out 24 to 30 August. That is one row: date 24th, end_date 30th.
  const holiday = (over = {}) => {
    db.hours_exceptions.push({
      id: 'he1', beautician_id: 'b1', date: '2026-08-24', end_date: '2026-08-30',
      type: 'closed', is_closed: true, start_time: null, end_time: null, reason: 'holiday',
      ...over,
    });
  };

  it('closes every day between date and end_date, not just the first', async () => {
    holiday();
    const blocks = await loadBlocks('b1', new Date('2026-08-24T00:00:00Z'), new Date('2026-08-31T00:00:00Z'));

    for (const day of ['2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28', '2026-08-29', '2026-08-30']) {
      expect(blocks.closedDays.has(day), `${day} was left bookable`).toBe(true);
    }
    // And it stops where the range stops.
    expect(blocks.closedDays.has('2026-08-31')).toBe(false);
    expect(blocks.closedDays.has('2026-08-23')).toBe(false);
  });

  it('still treats a row with no end_date as a single day', async () => {
    db.hours_exceptions.push({
      id: 'he2', beautician_id: 'b1', date: '2026-08-24', end_date: null,
      type: 'closed', is_closed: true, start_time: null, end_time: null,
    });
    const blocks = await loadBlocks('b1', new Date('2026-08-24T00:00:00Z'), new Date('2026-08-31T00:00:00Z'));
    expect(blocks.closedDays.has('2026-08-24')).toBe(true);
    expect(blocks.closedDays.has('2026-08-25')).toBe(false);
  });

  it('finds a closure that started before the window and is still running', async () => {
    holiday();
    // Asking about the 27th only. The row that closes it starts three days earlier.
    const blocks = await loadBlocks('b1', new Date('2026-08-27T00:00:00Z'), new Date('2026-08-28T00:00:00Z'));
    expect(blocks.closedDays.has('2026-08-27')).toBe(true);
  });

  it('offers no free slots on a day inside the range', async () => {
    holiday();
    const slots = await getFreeSlots('b1', {
      workingHours: ALL_WEEK, fromWall: new Date('2026-08-27T08:00:00Z'),
      days: 1, leadHours: 0, durationMinutes: 60,
    });
    expect(slots).toHaveLength(0);
  });

  it('refuses a booking on the 27th, the middle of the holiday', async () => {
    holiday();
    const out = await run(bookingRouter, 'post', '/:slug/book', {
      params: { slug: 'ellindigo' },
      body: bookBody({ starts_at: '2026-08-27T11:00:00' }),
    });

    expect(out.status).toBe(409);
    expect(out.body.error).toMatch(/no longer available/i);
    expect(db.appointments, 'a booking was taken inside her holiday').toHaveLength(0);
  });

  it('will not store a range that ends before it starts', async () => {
    const out = await run(hoursRouter, 'post', '/', {
      body: { date: '2026-08-30', end_date: '2026-08-24', type: 'closed', reason: 'holiday' },
    });

    expect(out.status).toBe(400);
    expect(out.body.error).toMatch(/end_date/i);
    expect(db.hours_exceptions).toHaveLength(0);
  });

  it('stores a blank end_date as a single day rather than an empty range', async () => {
    const out = await run(hoursRouter, 'post', '/', {
      body: { date: '2026-08-30', end_date: '', type: 'closed', reason: 'holiday' },
    });
    expect(out.status).toBe(201);
    expect(db.hours_exceptions[0].end_date).toBeUndefined();
  });
});

/* =============================================================== B. vouchers == */

describe('a gift voucher the salon actually sold', () => {
  const voucher = (over = {}) => {
    db.gift_vouchers.push({
      id: 'gv1', beautician_id: 'b1', code: 'GIFT50', amount_cents: 5000,
      remaining_cents: 5000, status: 'active', expires_at: null, ...over,
    });
  };

  it('is recognised by /validate-code, with the pence still on it', async () => {
    voucher();
    const out = await run(bookingRouter, 'post', '/:slug/validate-code', {
      params: { slug: 'ellindigo' }, body: { code: 'gift50' },
    });

    expect(out.status, 'a real voucher came back as "Code not recognised"').toBe(200);
    expect(out.body.valid).toBe(true);
    expect(out.body.type).toBe('voucher');
    expect(out.body.discount_type).toBe('fixed');
    expect(out.body.discount_value).toBe(5000);
  });

  it('quotes what is LEFT on a part-used voucher, not its face value', async () => {
    voucher({ amount_cents: 10000, remaining_cents: 2500 });
    const out = await run(bookingRouter, 'post', '/:slug/validate-code', {
      params: { slug: 'ellindigo' }, body: { code: 'GIFT50' },
    });
    expect(out.body.discount_value).toBe(2500);
  });

  it('says "could not check", not "not recognised", when the lookup fails', async () => {
    voucher();
    failing.set('gift_vouchers', { code: '08006', message: 'connection failed' });

    const out = await run(bookingRouter, 'post', '/:slug/validate-code', {
      params: { slug: 'ellindigo' }, body: { code: 'GIFT50' },
    });

    // The distinction that matters: a code we could not check is not a code
    // that does not exist, and the client must not be told it is.
    expect(out.status).not.toBe(404);
    expect(out.status).toBe(503);
    expect(out.body.unchecked).toBe(true);
    expect(out.body.error).not.toMatch(/not recognised/i);
  });

  it('still says "not recognised" for a code that genuinely is not one', async () => {
    voucher();
    const out = await run(bookingRouter, 'post', '/:slug/validate-code', {
      params: { slug: 'ellindigo' }, body: { code: 'NOSUCHTHING' },
    });
    expect(out.status).toBe(404);
    expect(out.body.error).toMatch(/not recognised/i);
  });

  it('is actually taken off the bill at /book, and drawn down', async () => {
    voucher();
    const out = await run(bookingRouter, 'post', '/:slug/book', {
      params: { slug: 'ellindigo' },
      body: bookBody({ discount_code: 'GIFT50', payment_type: 'full' }),
    });

    expect(out.status).toBe(201);
    const appt = db.appointments[0];
    expect(appt.discount_cents, 'the client paid full price for her own gift voucher').toBe(5000);
    expect(appt.discount_meta.type).toBe('voucher');
    expect(appt.discount_meta.code).toBe('GIFT50');

    // Stripe was asked for the discounted amount, not the full GBP 80.
    const line = stripeState.sessions[0]?.line_items?.[0];
    expect(line.price_data.unit_amount).toBe(3000);

    // GBP 50 of a GBP 50 voucher used, so nothing left and it closes.
    expect(db.gift_vouchers[0].remaining_cents).toBe(0);
    expect(db.gift_vouchers[0].status).toBe('redeemed');
  });

  it('keeps the change on a voucher worth more than the treatment', async () => {
    voucher({ amount_cents: 10000, remaining_cents: 10000 });
    await run(bookingRouter, 'post', '/:slug/book', {
      params: { slug: 'ellindigo' },
      body: bookBody({ discount_code: 'GIFT50', payment_type: 'full' }),
    });

    // GBP 80 treatment against a GBP 100 voucher leaves GBP 20, and the row
    // stays active. Marking the whole thing redeemed burned the difference.
    expect(db.gift_vouchers[0].remaining_cents).toBe(2000);
    expect(db.gift_vouchers[0].status).toBe('active');
  });

  it('refuses the booking rather than silently charging full price when it cannot check', async () => {
    voucher();
    failing.set('gift_vouchers', { code: '08006', message: 'connection failed' });

    const out = await run(bookingRouter, 'post', '/:slug/book', {
      params: { slug: 'ellindigo' }, body: bookBody({ discount_code: 'GIFT50' }),
    });

    expect(out.status).toBe(503);
    expect(db.appointments).toHaveLength(0);
  });
});

/* =============================================================== C. packages == */

describe('a prepaid package the client has already paid for', () => {
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

  it('is shown to her by /check-packages, with the sessions she has left', async () => {
    sixPack();
    const out = await run(bookingRouter, 'post', '/:slug/check-packages', {
      params: { slug: 'ellindigo' }, body: { phone: '07700900123', treatment_id: 't1' },
    });

    expect(out.body.packages, 'she was told she has no packages at all').toHaveLength(1);
    expect(out.body.packages[0]).toMatchObject({
      client_package_id: 'cp1', package_name: 'Six lash lifts',
      sessions_remaining: 4, sessions_total: 6,
    });
  });

  it('is not offered once every session is used', async () => {
    sixPack({ sessions_used: 6 });
    const out = await run(bookingRouter, 'post', '/:slug/check-packages', {
      params: { slug: 'ellindigo' }, body: { phone: '07700900123' },
    });
    expect(out.body.packages).toHaveLength(0);
  });

  it('says so rather than showing an empty list when it cannot look', async () => {
    sixPack();
    failing.set('client_packages', { code: '08006', message: 'connection failed' });

    const out = await run(bookingRouter, 'post', '/:slug/check-packages', {
      params: { slug: 'ellindigo' }, body: { phone: '07700900123' },
    });

    expect(out.status).toBe(503);
    expect(out.body.unchecked).toBe(true);
  });

  it('redeems a session at /book instead of sending her back to Stripe', async () => {
    sixPack();
    const out = await run(bookingRouter, 'post', '/:slug/book', {
      params: { slug: 'ellindigo' }, body: bookBody({ client_package_id: 'cp1' }),
    });

    expect(out.status).toBe(201);
    expect(stripeState.sessions, 'she was charged again for a session she owns').toHaveLength(0);
    expect(out.body.checkout_url).toBeFalsy();

    const appt = db.appointments[0];
    expect(appt.package_redemption).toBe(true);
    expect(appt.client_package_id).toBe('cp1');
    expect(appt.status).toBe('confirmed');
    expect(db.client_packages[0].sessions_used).toBe(3);
  });

  it('closes the package off on the last session', async () => {
    sixPack({ sessions_used: 5 });
    await run(bookingRouter, 'post', '/:slug/book', {
      params: { slug: 'ellindigo' }, body: bookBody({ client_package_id: 'cp1' }),
    });
    expect(db.client_packages[0].sessions_used).toBe(6);
    expect(db.client_packages[0].status).toBe('completed');
  });

  it('will not quietly charge her when the package cannot be verified', async () => {
    sixPack();
    failing.set('client_packages', { code: '08006', message: 'connection failed' });

    const out = await run(bookingRouter, 'post', '/:slug/book', {
      params: { slug: 'ellindigo' }, body: bookBody({ client_package_id: 'cp1' }),
    });

    expect(out.status).toBe(503);
    expect(stripeState.sessions).toHaveLength(0);
    expect(db.appointments).toHaveLength(0);
  });

  it('refuses a package belonging to somebody else', async () => {
    sixPack({ client_id: 'c-someone-else' });
    const out = await run(bookingRouter, 'post', '/:slug/book', {
      params: { slug: 'ellindigo' }, body: bookBody({ client_package_id: 'cp1' }),
    });

    expect(out.status).toBe(409);
    expect(db.client_packages[0].sessions_used, 'someone else’s session was spent').toBe(2);
  });
});

/* =============================================================== D. waitlist == */

describe('telling somebody a slot opened up', () => {
  const seedAppointment = (over = {}) => {
    const appt = {
      id: 'a1', beautician_id: 'b1', client_id: 'c1', management_token: 'mt1',
      status: 'confirmed', duration_minutes: 60, buffer_minutes: 0, extra_padding_minutes: 0,
      starts_at: nextWeekday(3, 2), ends_at: nextWeekday(3, 2), policy_snapshot: {},
      client_email: 'charlotte@example.com', treatment_id: 't1', rescheduled_at: null,
      beauticians: {
        id: 'b1', booking_slug: 'ellindigo', booking_policy: {}, business_name: 'Ellindigo',
        first_name: 'Ellie', working_hours: ALL_WEEK,
      },
      treatments: { name: 'Hybrid stain' },
      clients: { first_name: 'Charlotte', email: 'charlotte@example.com' },
      ...over,
    };
    db.appointments.push(appt);
    return appt;
  };

  const waiting = (over = {}) => {
    db.clients.push({
      id: 'c2', beautician_id: 'b1', first_name: 'Priya', last_name: 'Shah',
      email: 'priya@example.com', phone: '07700900456',
      marketing_consent: true, marketing_opted_out_at: null, messaging_autonomy: null,
      ...(over.client || {}),
    });
    db.waitlist.push({
      id: 'w1', beautician_id: 'b1', client_id: 'c2', treatment_id: 't1',
      status: 'waiting', notified_at: null, notify_count: 0,
      preferred_days: ['wed'], preferred_time: 'any',
      created_at: '2026-08-01T09:00:00Z',
      ...(over.entry || {}),
    });
  };

  const reschedule = async () => {
    const out = await run(bookingRouter, 'post', '/:slug/manage/:token/reschedule', {
      params: { slug: 'ellindigo', token: 'mt1' }, body: { new_starts_at: nextWeekday(4, 2) },
    });
    await settleBackground();
    return out;
  };

  it('reaches the client on the waitlist at all', async () => {
    seedAppointment();
    waiting();

    const out = await reschedule();
    expect(out.status).toBe(200);

    // Contact details come through client_id. Nothing on the waitlist row has
    // ever held a phone number.
    expect(sent.sms, 'nobody was told the slot opened up').toHaveLength(1);
    expect(sent.sms[0].to).toBe('07700900456');
    expect(sent.sms[0].body).toContain('Priya');
    expect(sent.sms[0].body).toMatch(/slot has just opened up/i);
    expect(db.waitlist[0].notified_at).toBeTruthy();
    expect(db.waitlist[0].notify_count).toBe(1);
  });

  it('goes through the outbound guard, so it is logged like every other send', async () => {
    seedAppointment();
    waiting();
    await reschedule();

    expect(db.outbound_sends).toHaveLength(1);
    expect(db.outbound_sends[0]).toMatchObject({
      beautician_id: 'b1', client_id: 'c2', message_type: 'waitlist_alert',
      tier: 'proactive', status: 'sent',
    });
  });

  it('does not text a client who has opted out', async () => {
    seedAppointment();
    waiting({ client: { marketing_opted_out_at: '2026-07-01T10:00:00Z' } });

    const out = await reschedule();
    expect(out.status).toBe(200);

    // This is the half that matters. Sent straight, with no evaluateOutbound,
    // she gets a marketing text after saying STOP.
    expect(sent.sms, 'a client who opted out was texted anyway').toHaveLength(0);
    expect(sent.email).toHaveLength(0);
    expect(db.outbound_sends[0]).toMatchObject({ status: 'blocked', reason: 'opted_out' });
    // And she is not quietly marked as told.
    expect(db.waitlist[0].notified_at).toBeFalsy();
  });

  it('does not spend the same person twice by texting AND emailing her', async () => {
    seedAppointment();
    waiting();
    await reschedule();

    expect(sent.sms.length + sent.email.length).toBe(1);
  });

  it('emails when there is no phone number', async () => {
    seedAppointment();
    waiting({ client: { phone: null } });
    await reschedule();

    expect(sent.email).toHaveLength(1);
    expect(sent.email[0].to).toBe('priya@example.com');
    // The subject line carried an em dash, which the owner of this codebase
    // removes on sight. Named by codepoint so this file does not contain one.
    expect(sent.email[0].subject).not.toContain('\u2014');
  });
});

/* ============================================================== E. past guard == */

describe('the past is the past on the salon clock, not the server clock', () => {
  afterEach(() => { vi.useRealTimers(); });

  // 09:10 in London on a BST morning. The instant is 08:10 UTC.
  const atBstMorning = () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-19T08:10:00.000Z'));
  };

  it('refuses a wall slot that has already gone, even though the instant has not', async () => {
    atBstMorning();
    // The assumption production pins in src/index.js: a zoneless booking time
    // is read as the salon wall clock.
    expect(new Date('2026-08-19T08:30:00').toISOString()).toBe('2026-08-19T08:30:00.000Z');

    const out = await run(bookingRouter, 'post', '/:slug/book', {
      params: { slug: 'ellindigo' },
      // 08:30 on the salon wall clock. It is 09:10 there. This is 40 minutes ago.
      body: bookBody({ starts_at: '2026-08-19T08:30:00' }),
    });

    expect(out.status, 'a slot 40 minutes in the past was accepted').toBe(400);
    expect(out.body.error).toMatch(/in the past/i);
    expect(db.appointments).toHaveLength(0);
  });

  it('still accepts a slot that is genuinely still to come', async () => {
    atBstMorning();
    const out = await run(bookingRouter, 'post', '/:slug/book', {
      params: { slug: 'ellindigo' },
      body: bookBody({ starts_at: '2026-08-19T14:00:00' }),
    });

    expect(out.status).toBe(201);
    // Nobody in this file's fixture has ever been in, so the health questions
    // are asked and the form is texted. It is asserted here rather than left
    // to a mock returning true, because a consultation nothing can observe is
    // how the 926 imported clients went unasked for four months. The rule
    // itself is pinned in tests/unit/consultation-gate.test.js.
    await new Promise(r => setTimeout(r, 0));
    expect(consultation.sent).toHaveLength(1);
  });

  it('measures the notice period on the same clock', async () => {
    atBstMorning();
    db.beauticians[0].booking_policy = { min_booking_hours: 2 };

    // 10:30 wall is 1h20 away from 09:10 wall. Against a real UTC instant it
    // measured 2h20 and sailed through a 2 hour notice period.
    const out = await run(bookingRouter, 'post', '/:slug/book', {
      params: { slug: 'ellindigo' },
      body: bookBody({ starts_at: '2026-08-19T10:30:00' }),
    });

    expect(out.status).toBe(400);
    expect(out.body.error).toMatch(/at least 2 hours in advance/i);
  });
});

/* ======================================================= H. consent evidence ==
 * UK GDPR art 7(1): the controller must be able to DEMONSTRATE consent. The
 * new-client branch wrote marketing_consent_at when the box was ticked; the
 * returning-client branch fired an update at whichever rows shared the last
 * nine digits of the typed phone and threw the error away. So a returning
 * client who ticked the box had no timestamp on her own row, and once the
 * marketing guard began failing closed (2 September 2026) she was refused
 * the offers she had just asked for, forever, with nothing in the logs.
 */
describe('the consent box is recorded on both booking branches', () => {
  const stranger = (over = {}) => bookBody({
    client_name: 'Priya Nair', client_email: 'priya@example.com', client_phone: '07700900999',
    payment_type: 'full', ...over,
  });

  it('a new client who ticks the box gets consent and a timestamp', async () => {
    const out = await run(bookingRouter, 'post', '/:slug/book', {
      params: { slug: 'ellindigo' }, body: stranger({ marketing_opt_in: true }),
    });
    expect(out.status).toBe(201);
    const priya = db.clients.find(c => c.email === 'priya@example.com');
    expect(priya.marketing_consent).toBe(true);
    expect(priya.marketing_consent_at).toBeTruthy();
  });

  it('a new client who leaves it unticked gets no consent written', async () => {
    const out = await run(bookingRouter, 'post', '/:slug/book', {
      params: { slug: 'ellindigo' }, body: stranger({ marketing_opt_in: false }),
    });
    expect(out.status).toBe(201);
    const priya = db.clients.find(c => c.email === 'priya@example.com');
    expect(priya.marketing_consent).toBeUndefined();
    expect(priya.marketing_consent_at).toBeUndefined();
  });

  it('a returning client with no consent on file who ticks the box is recorded, on HER row', async () => {
    // Matched by email, and her stored phone is not the one she typed today:
    // the old last-nine-digits update would have found nobody.
    db.clients[0].marketing_consent = false;
    db.clients[0].marketing_consent_at = null;
    db.clients.push({
      id: 'c2', beautician_id: 'b1', first_name: 'Other', phone: '07700900123',
      email: 'other@example.com', marketing_consent: false, marketing_opted_out_at: null,
    });
    const out = await run(bookingRouter, 'post', '/:slug/book', {
      params: { slug: 'ellindigo' },
      body: bookBody({ client_phone: '07123456789', marketing_opt_in: true, payment_type: 'full' }),
    });
    expect(out.status).toBe(201);
    expect(db.clients).toHaveLength(2);
    expect(db.clients[0].marketing_consent).toBe(true);
    expect(db.clients[0].marketing_consent_at).toBeTruthy();
    // The other client on the same digits was never asked and is untouched.
    expect(db.clients[1].marketing_consent).toBe(false);
  });

  it('ticking the box today supersedes an earlier STOP', async () => {
    db.clients[0].marketing_consent = false;
    db.clients[0].marketing_opted_out_at = '2026-08-31T20:00:00Z';
    const out = await run(bookingRouter, 'post', '/:slug/book', {
      params: { slug: 'ellindigo' }, body: bookBody({ marketing_opt_in: true, payment_type: 'full' }),
    });
    expect(out.status).toBe(201);
    expect(db.clients[0].marketing_consent).toBe(true);
    expect(db.clients[0].marketing_opted_out_at).toBeNull();
    expect(db.clients[0].marketing_consent_at).toBeTruthy();
  });

  it('an unticked box never downgrades a returning client, and never clears a STOP', async () => {
    db.clients[0].marketing_consent = true;
    db.clients[0].marketing_consent_at = '2026-01-01T00:00:00Z';
    await run(bookingRouter, 'post', '/:slug/book', {
      params: { slug: 'ellindigo' }, body: { ...bookBody({ payment_type: 'full' }), marketing_opt_in: false },
    });
    expect(db.clients[0].marketing_consent).toBe(true);
    expect(db.clients[0].marketing_consent_at).toBe('2026-01-01T00:00:00Z');

    db.appointments.length = 0;
    db.clients[0].marketing_consent = false;
    db.clients[0].marketing_opted_out_at = '2026-08-31T20:00:00Z';
    await run(bookingRouter, 'post', '/:slug/book', {
      params: { slug: 'ellindigo' }, body: { ...bookBody({ payment_type: 'full' }), marketing_opt_in: false },
    });
    expect(db.clients[0].marketing_consent).toBe(false);
    expect(db.clients[0].marketing_opted_out_at).toBe('2026-08-31T20:00:00Z');
  });

  it('keeps the original consent date when consent already stands', async () => {
    db.clients[0].marketing_consent = true;
    db.clients[0].marketing_consent_at = '2026-01-01T00:00:00Z';
    await run(bookingRouter, 'post', '/:slug/book', {
      params: { slug: 'ellindigo' }, body: bookBody({ marketing_opt_in: true, payment_type: 'full' }),
    });
    // The earlier date is the evidence; re-stamping it would erase the proof.
    expect(db.clients[0].marketing_consent_at).toBe('2026-01-01T00:00:00Z');
  });
});
