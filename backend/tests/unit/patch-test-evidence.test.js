/**
 * SOPHIE, 26 AUGUST, AND A PATCH TEST SHE HAD ALREADY HAD.
 *
 * She moved her appointment with the link on the manage page. The page then
 * told her she needed a patch test. She booked one. Ellie had to message her:
 *
 *   "Hey Soph, It's Ellie! You don't need another patch test I've cancelled
 *    it. Thank you for using the link to move the appointment xx"
 *
 * and told us: "It let her move the appointment but saying she needed a patch
 * test but she's been to me before."
 *
 * A slot out of the diary, a confused client, and the owner cleaning up by
 * hand after her own software.
 *
 * THREE THINGS WERE WRONG AND THIS FILE PINS ALL THREE.
 *
 * 1. The test for a valid patch test could never be true. booking.js read
 *    `pt.status === 'passed'`. Nothing in this codebase writes 'passed'. The
 *    schema does not know the word: patch_tests.result carries
 *    CHECK (result IN ('pending','pass','fail','reaction')) from 007, and
 *    patch_tests.status was added by 078 as bare unconstrained text defaulting
 *    to 'pending'. So hasValidPatchTest was false for every client alive, and
 *    the only thing standing between anybody and the demand was
 *    hasPendingPatchTest, which needs a patch_tests row to exist at all.
 *
 * 2. A client tested in the chair has no row. Nothing was ever written for
 *    her, so the demand never went away, and would not have gone away after
 *    the wasted slot either.
 *
 * 3. There was no way for Ellie to say otherwise. The one form that looks
 *    like it records a patch test wrote client_name and notes, two columns
 *    patch_tests has never had, with client_id NULL against a NOT NULL
 *    constraint. PostgREST rejects the whole statement for one unknown
 *    column and reports it by RESOLVING with { data: null, error }; the
 *    frontend swallowed the throw and put the row in the list anyway.
 *
 * The fake below therefore does what the real database does: it knows the
 * columns patch_tests actually has, taken from supabase/migrations, and
 * refuses a select, a filter or an INSERT that names anything else. A stub
 * that accepts whatever you hand it cannot fail on defect 3, which is why
 * nobody ever noticed that no patch test has ever been logged by hand.
 */
process.env.TZ = 'UTC';   // what src/index.js pins in production, and why.

import { describe, it, expect, beforeEach, vi } from 'vitest';

/* ------------------------------------------------------------------ schema --
 * Column lists copied from supabase/migrations. Only the tables this defect
 * lives in are enforced; everything else passes through.
 *
 *   patch_tests  007_all_features.sql:45          the original table
 *                030_booking_policy_client_portal treatment_category
 *                034_patch_test_auto_booking      the auto-booking columns
 *                078_schema_sweep_repairs         status, and test_date NULLable
 *   treatments   001_initial_schema.sql:75 + 017 + 037 + 072 + backend009/012
 */
const COLUMNS = {
  patch_tests: [
    'id', 'beautician_id', 'client_id', 'treatment_id', 'product_used',
    'test_date', 'result', 'reaction_notes', 'photo_url', 'expires_at',
    'created_at', 'updated_at',
    'treatment_category',
    'appointment_id', 'suggested_slot', 'suggested_at', 'confirmed_at',
    'confirmation_deadline', 'auto_booked',
    'status',
  ],
  treatments: [
    'id', 'beautician_id', 'name', 'description', 'duration_minutes',
    'buffer_minutes', 'price_cents', 'deposit_cents', 'category',
    'product_cost_cents', 'contraindications', 'is_active', 'booking_enabled',
    'sort_order', 'created_at', 'updated_at', 'color', 'requires_patch_test',
    'requires_consultation', 'deposit_percent', 'consultation_form_id',
    'location_id',
  ],
};

/** NOT NULL with no default: 007 declares these on patch_tests. */
const REQUIRED = { patch_tests: ['beautician_id', 'client_id'] };

/** The CHECK constraint that makes 'passed' impossible in the first place. */
const CHECKS = { 'patch_tests.result': ['pending', 'pass', 'fail', 'reaction'] };

const RELATIONS = {
  patch_tests: { appointments: { table: 'appointments', fk: 'appointment_id' } },
};

const db = {
  beauticians: [], clients: [], treatments: [], appointments: [],
  patch_tests: [], consultation_responses: [], transactions: [],
};
const reset = () => { for (const t of Object.keys(db)) db[t] = []; };

let idCounter = 0;
const nextId = (p) => `${p}_${++idCounter}`;

const undefinedColumn = (table, col) => ({
  code: '42703', message: `column ${table}.${col} does not exist`, details: null, hint: null,
});
const notNull = (table, col) => ({
  code: '23502',
  message: `null value in column "${col}" of relation "${table}" violates not-null constraint`,
  details: null, hint: null,
});
const checkViolation = (table, col) => ({
  code: '23514',
  message: `new row for relation "${table}" violates check constraint "${table}_${col}_check"`,
  details: null, hint: null,
});

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

function parseSelect(table, spec) {
  const embeds = [];
  if (!spec || spec === '*') return { error: null, embeds };
  for (const item of splitTop(spec)) {
    const nested = /^([\w]+)\s*\(([\s\S]*)\)$/.exec(item);
    if (nested) {
      const [, rel, inner] = nested;
      embeds.push(rel);
      const relTable = RELATIONS[table]?.[rel]?.table || rel;
      const known = COLUMNS[relTable];
      if (known) {
        for (const c of splitTop(inner)) {
          const col = c.includes(':') ? c.split(':').pop().trim() : c;
          if (col !== '*' && !known.includes(col)) return { error: undefinedColumn(relTable, col), embeds };
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

/** What the database does to a row on the way in. */
function validateWrite(table, payload, { isInsert }) {
  const known = COLUMNS[table];
  if (!known) return null;
  for (const col of Object.keys(payload)) {
    if (!known.includes(col)) return undefinedColumn(table, col);
  }
  for (const [key, allowed] of Object.entries(CHECKS)) {
    const [t, col] = key.split('.');
    if (t !== table) continue;
    const v = payload[col];
    if (v !== undefined && v !== null && !allowed.includes(v)) return checkViolation(table, col);
  }
  if (isInsert) {
    for (const col of REQUIRED[table] || []) {
      if (payload[col] === undefined || payload[col] === null) return notNull(table, col);
    }
  }
  return null;
}

const failing = new Map();   // table -> PostgREST style error

function makeBuilder(table) {
  const filters = [];
  let pending = null;
  let embeds = [];
  let selectError = null;
  let filterError = null;

  const known = COLUMNS[table];
  const guard = (c) => {
    if (!filterError && known && !known.includes(c)) filterError = undefinedColumn(table, c);
  };

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
    if (failing.has(table)) return { data: null, error: failing.get(table) };
    if (filterError) return { data: null, error: filterError };
    if (selectError) return { data: null, error: selectError };

    if (pending?.op === 'insert') {
      const payloads = Array.isArray(pending.payload) ? pending.payload : [pending.payload];
      const created = [];
      for (const p of payloads) {
        const err = validateWrite(table, p, { isInsert: true });
        if (err) return { data: null, error: err };
        const row = {
          id: nextId(table), created_at: new Date().toISOString(),
          // 007 gives result a DEFAULT of 'pending'. A row that does not say
          // otherwise says pending, which is the whole reason nothing has ever
          // recorded a pass.
          ...(table === 'patch_tests' ? { result: 'pending', status: 'pending' } : {}),
          ...p,
        };
        db[table].push(row);
        created.push(row);
      }
      return { data: withEmbeds(created), error: null };
    }

    if (pending?.op === 'update') {
      const err = validateWrite(table, pending.payload, { isInsert: false });
      if (err) return { data: null, error: err };
      const rows = matching();
      for (const r of rows) Object.assign(r, pending.payload);
      return { data: withEmbeds(rows), error: null };
    }

    if (pending?.op === 'delete') {
      const gone = matching();
      db[table] = (db[table] || []).filter(r => !filters.every(f => f(r)));
      return { data: gone, error: null };
    }

    return { data: withEmbeds(matching()), error: null };
  };

  const b = {
    select(spec = '*') {
      const parsed = parseSelect(table, spec);
      selectError = parsed.error;
      embeds = parsed.embeds;
      return b;
    },
    insert(p) { pending = { op: 'insert', payload: p }; return b; },
    update(p) { pending = { op: 'update', payload: p }; return b; },
    delete() { pending = { op: 'delete' }; return b; },
    eq(c, v) { guard(c); filters.push(r => r[c] === v); return b; },
    neq(c, v) { guard(c); filters.push(r => r[c] !== v); return b; },
    in(c, v) { guard(c); filters.push(r => v.includes(r[c])); return b; },
    is(c, v) { guard(c); filters.push(r => (r[c] ?? null) === v); return b; },
    or() { return b; },
    not(c, op, v) {
      guard(c);
      if (op === 'in') { const list = String(v).replace(/[()]/g, '').split(','); filters.push(r => !list.includes(String(r[c]))); }
      else filters.push(r => (r[c] ?? null) !== null);
      return b;
    },
    ilike(c, v) {
      guard(c);
      const needle = String(v).replace(/%/g, '').toLowerCase();
      filters.push(r => String(r[c] ?? '').toLowerCase().includes(needle));
      return b;
    },
    gte(c, v) { guard(c); filters.push(r => String(r[c]) >= String(v)); return b; },
    lte(c, v) { guard(c); filters.push(r => String(r[c]) <= String(v)); return b; },
    gt(c, v) { guard(c); filters.push(r => String(r[c]) > String(v)); return b; },
    lt(c, v) { guard(c); filters.push(r => String(r[c]) < String(v)); return b; },
    order(c) { guard(c); return b; },
    limit() { return b; },
    maybeSingle() { const o = settle(); return Promise.resolve(o.error ? o : { data: (o.data || [])[0] || null, error: null }); },
    single() { const o = settle(); return Promise.resolve(o.error ? o : { data: (o.data || [])[0] || null, error: null }); },
    then(res, rej) { return Promise.resolve(settle()).then(res, rej); },
    catch(rej) { return Promise.resolve(settle()).catch(rej); },
  };
  return b;
}

const fakeSupabase = { from: (t) => makeBuilder(t) };
vi.mock('../../src/config.js', () => ({ supabase: fakeSupabase, supabaseAdmin: fakeSupabase }));

/* ------------------------------------------------------------------- mocks -- */
vi.mock('stripe', () => ({
  default: class {
    constructor() {
      this.customers = { create: async () => ({ id: 'cus_fake' }) };
      this.checkout = { sessions: { create: async () => ({ id: 'cs', url: 'https://x', payment_intent: 'pi' }) } };
      this.paymentIntents = { retrieve: async (id) => ({ id, status: 'succeeded' }) };
      this.events = { list: async () => ({ data: [] }) };
    }
  },
}));
vi.mock('../../src/services/notifications.js', () => ({
  notifyBookingConfirmed: async () => true, sendMessage: async () => ({ channel: 'sms' }),
  sendWhatsApp: async () => true, sendSMS: async () => ({ channel: 'sms' }),
  sendEmail: async () => ({ id: 'em' }), pickChannel: () => 'sms',
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
vi.mock('../../src/lib/outbound-guard.js', () => ({ guardedSend: async () => ({ delivered: false }) }));
vi.mock('@sentry/node', () => ({ captureMessage: () => {}, captureException: () => {}, setUser: () => {} }));

process.env.STRIPE_SECRET_KEY = 'sk_test_x';
process.env.FRONTEND_URL = 'https://florrie.ai';

const bookingRouter = (await import('../../src/routes/booking.js')).default;
const appointmentsRouter = (await import('../../src/routes/appointments.js')).default;
const { patchTestEvidence, patchTestPicture, RECORDED_BY_OWNER, patchTestWindowStart } =
  await import('../../src/lib/patch-test-status.js');

/** Drive one route handler straight, no HTTP server, no middleware. */
async function run(router, method, path, req = {}) {
  const layer = router.stack.find(l => l.route?.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`no ${method} ${path}`);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const out = { status: 200, body: null };
  const res = {
    status(c) { out.status = c; return res; },
    json(p) { out.body = p; return res; },
    redirect() { return res; }, end() { return res; },
    get() { return 'api.florrie.ai'; },
  };
  await handler({ headers: {}, get: () => 'api.florrie.ai', query: {}, body: {}, params: {}, ...req }, res);
  return out;
}

/* --------------------------------------------------------------- fixtures -- */
const BIZ = 'b1';
const SLUG = 'ellindigo';
const TOKEN = '0d4b3a52-4d54-4f5e-9a01-2c9f2d7b1b11';
const SOPHIE = 'c-sophie';

/** Dates as wall days, the frame appointments.starts_at is stored in. */
const day = (offsetDays) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};
const at = (offsetDays, hhmm = '11:00') => `${day(offsetDays)}T${hhmm}:00`;

const OWNER = {
  id: BIZ, booking_slug: SLUG, business_name: 'Ellindigo', first_name: 'Ellie',
  timezone: 'Europe/London', booking_policy: {}, payment_settings: {},
  working_hours: { mon: { start: '09:00', end: '18:00' }, tue: { start: '09:00', end: '18:00' },
    wed: { start: '09:00', end: '18:00' }, thu: { start: '09:00', end: '18:00' },
    fri: { start: '09:00', end: '18:00' }, sat: { start: '09:00', end: '18:00' },
    sun: { start: '09:00', end: '18:00' } },
  patch_test_expiry_months: 6, patch_test_block_booking: false,
};

/** Ellie's two treatments: one needs a patch test, one does not. */
const LAMINATION = 't-lam';   // requires_patch_test true
const WAX = 't-wax';          // requires_patch_test false

function seed() {
  reset();
  idCounter = 0;
  failing.clear();
  db.beauticians.push({ ...OWNER });
  db.clients.push({
    id: SOPHIE, beautician_id: BIZ, first_name: 'Sophie', last_name: 'M',
    email: 'sophie@example.com', phone: '07700900321', stripe_customer_id: null,
    blocked_at: null, archived_at: null,
  });
  db.treatments.push(
    { id: LAMINATION, beautician_id: BIZ, name: 'Brow lamination', duration_minutes: 60,
      buffer_minutes: 0, price_cents: 4000, category: 'Brows', is_active: true,
      requires_patch_test: true, sort_order: 1 },
    { id: WAX, beautician_id: BIZ, name: 'Brow wax', duration_minutes: 15,
      buffer_minutes: 0, price_cents: 1200, category: 'Brows', is_active: true,
      requires_patch_test: false, sort_order: 2 },
  );
}

/**
 * The booking she moved: a treatment that needs a patch test, three weeks out.
 * The manage payload is the exact thing she was shown.
 */
function seedTheBookingSheMoved(treatmentId = LAMINATION) {
  const t = db.treatments.find(x => x.id === treatmentId);
  db.appointments.push({
    id: 'appt-moved', beautician_id: BIZ, client_id: SOPHIE,
    management_token: TOKEN, starts_at: at(21), ends_at: at(21, '12:00'),
    status: 'confirmed', treatment_id: treatmentId, extra_treatment_ids: null,
    price_cents: t.price_cents, deposit_cents: 0, deposit_paid: false,
    client_email: 'sophie@example.com', rescheduled_at: new Date().toISOString(),
    buffer_minutes: 0, extra_padding_minutes: 0,
    treatments: t, clients: db.clients[0], beauticians: db.beauticians[0],
  });
}

/** Her one prior visit, completed, for a treatment that requires a patch test. */
function seedPriorVisit(treatmentId = LAMINATION, offsetDays = -19) {
  db.appointments.push({
    id: `appt-prior-${treatmentId}-${offsetDays}`, beautician_id: BIZ, client_id: SOPHIE,
    starts_at: at(offsetDays), ends_at: at(offsetDays, '12:00'), status: 'completed',
    treatment_id: treatmentId, extra_treatment_ids: null,
  });
}

const manage = () => run(bookingRouter, 'get', '/:slug/manage/:token', {
  params: { slug: SLUG, token: TOKEN },
});

beforeEach(seed);

/* ================================================== the fake tells the truth = */

describe('the fake refuses what PostgREST refuses', () => {
  it('rejects a select naming a column no migration created', async () => {
    const { data, error } = await makeBuilder('patch_tests').select('id, client_name');
    expect(data).toBeNull();
    expect(error.code).toBe('42703');
  });

  it('rejects an INSERT naming a column no migration created', async () => {
    const { error } = await makeBuilder('patch_tests')
      .insert({ beautician_id: BIZ, client_id: SOPHIE, client_name: 'Sophie', notes: 'x' })
      .select().single();
    expect(error?.code).toBe('42703');
  });

  it("refuses 'passed' as a result, which is the word the code was testing for", async () => {
    const { error } = await makeBuilder('patch_tests')
      .insert({ beautician_id: BIZ, client_id: SOPHIE, result: 'passed' }).select().single();
    expect(error?.code).toBe('23514');
  });
});

/* ============================================ 1. the demand that never lifted = */

describe("the old rule could not be true for anybody", () => {
  it("no row in the fixture, or in production, has ever said 'passed'", () => {
    // Belt and braces on the reasoning above: the value is not merely absent
    // from the data, it is outside the CHECK constraint on result, and the
    // status column that DOES accept it is written 'pending' by every insert
    // in the codebase.
    expect(CHECKS['patch_tests.result']).not.toContain('passed');
  });

  it('a client with no patch_tests row at all is not evidence of anything', async () => {
    const e = await patchTestEvidence(fakeSupabase, BIZ, SOPHIE, { asOf: at(21) });
    expect(e.ok).toBe(false);
    expect(e.kind).toBe('none');
  });
});

/* ======================================== 2. SOPHIE. THE LOAD-BEARING TEST. == */

describe('Sophie moves her appointment', () => {
  it('is NOT told to book a patch test when she has been in for one that needed it', async () => {
    seedPriorVisit(LAMINATION);       // completed, requires_patch_test, 19 days ago
    seedTheBookingSheMoved();         // no patch_tests row anywhere

    const res = await manage();

    expect(res.status).toBe(200);
    expect(db.patch_tests).toHaveLength(0);        // she never had a row. She still does not.
    expect(res.body.needsPatchTest).toBe(false);   // the sentence that cost her a slot
    expect(res.body.blockBooking).toBe(false);
    expect(res.body.patchTest.required).toBe(true);
    expect(res.body.patchTest.certainty).toBe('satisfied');
    expect(res.body.patchTest.evidence).toBe('treatment');
    expect(res.body.patchTest.evidenceDate).toBe(day(-19));
    // Nothing is asked of anybody: the question is answered.
    expect(res.body.patchTest.ask).toBeNull();
  });

  it('the same client, if the prior treatment needed no patch test, is not told she is fine either', async () => {
    // This is the branch that decides whether rule 2 alone would have saved
    // her. If "Signature brows" does not carry requires_patch_test, a
    // completed Signature brows proves nothing, and the ONLY thing that would
    // have saved her is Ellie being able to say so herself.
    seedPriorVisit(WAX);
    seedTheBookingSheMoved();

    const res = await manage();

    expect(res.body.patchTest.evidence).toBe('none');
    // But she is still not told a flat lie: she has been here, so we do not
    // know, and not knowing is not the client's problem to solve.
    expect(res.body.patchTest.certainty).toBe('uncertain');
    expect(res.body.patchTest.ask).toBe('owner');
    expect(res.body.needsPatchTest).toBe(false);
  });

  it('and once Ellie records it, the answer is hers and it is definite', async () => {
    seedPriorVisit(WAX);
    seedTheBookingSheMoved();

    const rec = await run(appointmentsRouter, 'post', '/patch-test-records', {
      beautician: { id: BIZ, patch_test_expiry_months: 6 },
      body: { client_id: SOPHIE, test_date: day(-19) },
    });
    expect(rec.status).toBe(201);

    const res = await manage();
    expect(res.body.needsPatchTest).toBe(false);
    expect(res.body.patchTest.certainty).toBe('satisfied');
    expect(res.body.patchTest.evidence).toBe('recorded');
    expect(res.body.patchTest.evidenceDate).toBe(day(-19));
  });
});

/* ============================== a client who genuinely has never been in ==== */

describe('a first-time client is told plainly, because it is true of her', () => {
  it('gets the demand and the booking button', async () => {
    seedTheBookingSheMoved();         // no prior appointments at all

    const res = await manage();
    expect(res.body.needsPatchTest).toBe(true);
    expect(res.body.patchTest.certainty).toBe('never_visited');
    expect(res.body.patchTest.ask).toBe('client');
  });

  it('and is blocked from moving it only when Ellie has switched that on', async () => {
    db.beauticians[0].patch_test_block_booking = true;
    seedTheBookingSheMoved();
    const res = await manage();
    expect(res.body.blockBooking).toBe(true);
  });

  it('but a returning client is never blocked on a guess', async () => {
    db.beauticians[0].patch_test_block_booking = true;
    seedPriorVisit(WAX);
    seedTheBookingSheMoved();
    const res = await manage();
    expect(res.body.patchTest.certainty).toBe('uncertain');
    expect(res.body.blockBooking).toBe(false);
  });

  it('and one who has already booked her test is not asked twice', async () => {
    seedTheBookingSheMoved();
    db.patch_tests.push({
      id: 'pt-booked', beautician_id: BIZ, client_id: SOPHIE, status: 'pending',
      confirmed_at: new Date().toISOString(), appointment_id: 'appt-pt', test_date: null,
    });
    db.appointments.push({ id: 'appt-pt', beautician_id: BIZ, client_id: SOPHIE,
      starts_at: at(14), status: 'confirmed', treatment_id: null });
    const res = await manage();
    expect(res.body.patchTest.certainty).toBe('booked');
    expect(res.body.needsPatchTest).toBe(false);
  });
});

/* ==================================================== what counts, and when == */

describe('what the schema will actually let count as evidence', () => {
  const evidence = (opts = {}) => patchTestEvidence(fakeSupabase, BIZ, SOPHIE, { asOf: at(21), ...opts });

  it("counts result = 'pass', the word the CHECK constraint knows", async () => {
    db.patch_tests.push({ id: 'p1', beautician_id: BIZ, client_id: SOPHIE, result: 'pass', test_date: day(-30) });
    expect((await evidence())).toMatchObject({ ok: true, kind: 'result', when: day(-30) });
  });

  it("still reads the dead 'passed' spelling, so nothing that used it regresses", async () => {
    db.patch_tests.push({ id: 'p1', beautician_id: BIZ, client_id: SOPHIE, status: 'passed', test_date: day(-30) });
    expect((await evidence()).ok).toBe(true);
  });

  it('counts a patch test slot she actually came in for', async () => {
    db.appointments.push({ id: 'a-pt', beautician_id: BIZ, client_id: SOPHIE,
      starts_at: at(-40), status: 'completed', treatment_id: null });
    db.patch_tests.push({ id: 'p1', beautician_id: BIZ, client_id: SOPHIE, test_date: null,
      confirmed_at: at(-45), appointment_id: 'a-pt' });
    expect((await evidence())).toMatchObject({ ok: true, kind: 'attended', when: day(-40) });
  });

  it('does not count a slot she booked and has not attended', async () => {
    db.appointments.push({ id: 'a-pt', beautician_id: BIZ, client_id: SOPHIE,
      starts_at: at(3), status: 'confirmed', treatment_id: null });
    db.patch_tests.push({ id: 'p1', beautician_id: BIZ, client_id: SOPHIE, test_date: null,
      confirmed_at: new Date().toISOString(), appointment_id: 'a-pt' });
    const e = await evidence();
    expect(e.ok).toBe(false);
    expect(e.pending).toBe(true);
  });

  it('counts the treatment when it is an EXTRA rather than the main thing', async () => {
    db.appointments.push({
      id: 'a-extra', beautician_id: BIZ, client_id: SOPHIE, starts_at: at(-10),
      status: 'completed', treatment_id: WAX, extra_treatment_ids: [LAMINATION],
    });
    expect((await evidence())).toMatchObject({ ok: true, kind: 'treatment', when: day(-10) });
  });

  it('does not count an appointment that was cancelled or never happened', async () => {
    db.appointments.push({ id: 'a-x', beautician_id: BIZ, client_id: SOPHIE,
      starts_at: at(-10), status: 'cancelled', treatment_id: LAMINATION });
    db.appointments.push({ id: 'a-y', beautician_id: BIZ, client_id: SOPHIE,
      starts_at: at(-9), status: 'no_show', treatment_id: LAMINATION });
    expect((await evidence()).ok).toBe(false);
  });

  it('does not count another salon\'s client, or another salon\'s appointment', async () => {
    db.appointments.push({ id: 'a-other', beautician_id: 'b2', client_id: SOPHIE,
      starts_at: at(-10), status: 'completed', treatment_id: LAMINATION });
    expect((await evidence()).ok).toBe(false);
  });

  it('a recorded reaction is evidence, of the opposite thing, and is never a green light', async () => {
    db.patch_tests.push({ id: 'p1', beautician_id: BIZ, client_id: SOPHIE, result: 'reaction', test_date: day(-5) });
    const e = await evidence();
    expect(e.ok).toBe(false);
    expect(e.kind).toBe('adverse');
  });

  it('and the most recent thing on record wins, in either direction', async () => {
    db.patch_tests.push({ id: 'p1', beautician_id: BIZ, client_id: SOPHIE, result: 'reaction', test_date: day(-40) });
    db.patch_tests.push({ id: 'p2', beautician_id: BIZ, client_id: SOPHIE, status: RECORDED_BY_OWNER, test_date: day(-5) });
    expect((await evidence()).kind).toBe('recorded');

    db.patch_tests.push({ id: 'p3', beautician_id: BIZ, client_id: SOPHIE, result: 'fail', test_date: day(-1) });
    expect((await evidence()).kind).toBe('adverse');
  });

  it('refuses rather than reassures when the lookup itself fails', async () => {
    failing.set('patch_tests', { code: '42703', message: 'boom' });
    const e = await evidence();
    expect(e.kind).toBe('unknown');
    expect(e.ok).toBe(false);
  });

  it("and the page then asks the owner rather than telling the client anything", async () => {
    seedTheBookingSheMoved();
    failing.set('patch_tests', { code: '42703', message: 'boom' });
    const res = await manage();
    failing.clear();
    expect(res.body.patchTest.certainty).toBe('unknown');
    expect(res.body.patchTest.ask).toBe('owner');
    expect(res.body.needsPatchTest).toBe(false);
  });
});

/* ============================================================ the window ==== */

describe('the window is her setting, measured against the appointment', () => {
  it('runs from the appointment date, not from today', () => {
    // A test done in August covers September and does not cover next April.
    expect(patchTestWindowStart('2026-09-03', 6)).toBe('2026-03-03');
    expect(patchTestWindowStart('2027-03-01', 6)).toBe('2026-09-01');
  });

  it('honours a 3 month setting as three months', () => {
    expect(patchTestWindowStart('2026-09-03', 3)).toBe('2026-06-03');
  });

  it('a visit inside the window counts and one outside it does not', async () => {
    seedPriorVisit(LAMINATION, -100);
    seedTheBookingSheMoved();
    expect((await manage()).body.patchTest.certainty).toBe('satisfied');

    reset(); seed();
    seedPriorVisit(LAMINATION, -400);
    seedTheBookingSheMoved();
    const res = await manage();
    expect(res.body.patchTest.evidence).toBe('none');
    expect(res.body.patchTest.certainty).toBe('uncertain');
  });

  it('shortens the window when Ellie shortens it', async () => {
    db.beauticians[0].patch_test_expiry_months = 3;
    seedPriorVisit(LAMINATION, -100);
    seedTheBookingSheMoved();
    expect((await manage()).body.patchTest.evidence).toBe('none');
  });
});

/* ================================================= 3. Ellie's own record ==== */

describe('the owner records a patch test she did in the chair', () => {
  const record = (body) => run(appointmentsRouter, 'post', '/patch-test-records', {
    beautician: { id: BIZ, patch_test_expiry_months: 6 }, body,
  });

  it('writes a row against columns that exist, which nothing has managed before', async () => {
    const res = await record({ client_id: SOPHIE, test_date: day(-19) });
    expect(res.status).toBe(201);
    expect(db.patch_tests).toHaveLength(1);
    const row = db.patch_tests[0];
    expect(row.client_id).toBe(SOPHIE);
    expect(row.test_date).toBe(day(-19));
    expect(row.status).toBe(RECORDED_BY_OWNER);
  });

  it('does NOT invent a result the salon never gave it', async () => {
    await record({ client_id: SOPHIE, test_date: day(-19) });
    const row = db.patch_tests[0];
    // The column default, and nothing else. Not 'pass', and certainly not the
    // 'passed' that was never a legal value in the first place.
    expect(row.result).toBe('pending');
    expect(row.result).not.toBe('pass');
  });

  it('records an outcome only when a human states one, in the schema\'s own words', async () => {
    const ok = await record({ client_id: SOPHIE, test_date: day(-19), result: 'pass' });
    expect(ok.status).toBe(201);
    expect(db.patch_tests[0].result).toBe('pass');

    const bad = await record({ client_id: SOPHIE, test_date: day(-19), result: 'passed' });
    expect(bad.status).toBe(400);
  });

  it('is distinguishable from a slot a client booked, and from an inference', async () => {
    await record({ client_id: SOPHIE, test_date: day(-19) });
    const row = db.patch_tests[0];
    // Booked-but-not-attended carries an appointment_id and status 'pending'.
    expect(row.appointment_id).toBeNull();
    expect(row.auto_booked).toBe(false);
    expect(row.status).not.toBe('pending');
    // Settled rather than outstanding, which is all confirmed_at ever means.
    expect(row.confirmed_at).toBeTruthy();
    // An inference has no row at all, so a row IS the distinction.
  });

  it('leaves expires_at alone, because validity is one calculation and not a column', async () => {
    await record({ client_id: SOPHIE, test_date: day(-19) });
    expect(db.patch_tests[0].expires_at ?? null).toBeNull();
  });

  it('refuses a date in the future, which has not happened yet', async () => {
    const res = await record({ client_id: SOPHIE, test_date: day(3) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/future/i);
  });

  it('refuses a client belonging to another salon', async () => {
    db.clients.push({ id: 'c-other', beautician_id: 'b2', first_name: 'Someone' });
    const res = await record({ client_id: 'c-other', test_date: day(-1) });
    expect(res.status).toBe(404);
    expect(db.patch_tests).toHaveLength(0);
  });

  it('needs a client and a date, and says which is missing', async () => {
    expect((await record({ test_date: day(-1) })).status).toBe(400);
    expect((await record({ client_id: SOPHIE })).status).toBe(400);
    expect((await record({ client_id: SOPHIE, test_date: '7 August' })).status).toBe(400);
  });

  it('and reads back as "she came in", never as "she passed"', async () => {
    await record({ client_id: SOPHIE, test_date: day(-19) });
    const picture = await patchTestPicture(fakeSupabase, BIZ, SOPHIE);
    expect(picture.state).toBe('attended');
    expect(picture.when).toBe(day(-19));
  });
});

/* ============================================= 4. who is asked, and where === */

describe('the owner is the one asked when nobody knows', () => {
  const alerts = (query = {}) => run(appointmentsRouter, 'get', '/patch-test-alerts', {
    beautician: { id: BIZ, patch_test_expiry_months: 6 }, query,
  });

  it('lists the returning client the manage page deliberately said nothing to', async () => {
    seedPriorVisit(WAX);
    seedTheBookingSheMoved();

    const res = await alerts();
    expect(res.status).toBe(200);
    expect(res.body.alerts).toHaveLength(1);
    expect(res.body.alerts[0]).toMatchObject({
      client_id: SOPHIE,
      client_name: 'Sophie M',
      evidence: 'none',
      reason: 'been_in_but_nothing_on_record',
    });
    expect(res.body.alerts[0].completed_visits).toBe(1);
  });

  it('says of a first-timer that she has never been in, which is a different ask', async () => {
    seedTheBookingSheMoved();
    const res = await alerts();
    expect(res.body.alerts[0].reason).toBe('never_been_in');
  });

  it('drops her off the list the moment Ellie records one', async () => {
    seedPriorVisit(WAX);
    seedTheBookingSheMoved();
    await run(appointmentsRouter, 'post', '/patch-test-records', {
      beautician: { id: BIZ }, body: { client_id: SOPHIE, test_date: day(-19) },
    });
    expect((await alerts()).body.alerts).toHaveLength(0);
  });

  it('says nothing about a client whose evidence is already there', async () => {
    seedPriorVisit(LAMINATION);
    seedTheBookingSheMoved();
    expect((await alerts()).body.alerts).toHaveLength(0);
  });

  it('uses requires_patch_test rather than guessing from the treatment name', async () => {
    // The old page looked for 'tint' and 'lamination' in the name. This one
    // is called neither and still needs a test.
    db.treatments.push({ id: 't-odd', beautician_id: BIZ, name: 'The usual', duration_minutes: 30,
      price_cents: 3000, is_active: true, requires_patch_test: true });
    db.appointments.push({ id: 'a-odd', beautician_id: BIZ, client_id: SOPHIE, starts_at: at(5),
      status: 'confirmed', treatment_id: 't-odd', extra_treatment_ids: null,
      treatments: db.treatments.find(t => t.id === 't-odd'), clients: db.clients[0] });
    expect((await alerts()).body.alerts).toHaveLength(1);
  });

  it('catches a test-needing treatment added as an EXTRA', async () => {
    db.appointments.push({ id: 'a-ex', beautician_id: BIZ, client_id: SOPHIE, starts_at: at(5),
      status: 'confirmed', treatment_id: WAX, extra_treatment_ids: [LAMINATION],
      treatments: db.treatments.find(t => t.id === WAX), clients: db.clients[0] });
    expect((await alerts()).body.alerts).toHaveLength(1);
  });

  it('one line per person, not per booking', async () => {
    for (const n of [5, 9, 12]) {
      db.appointments.push({ id: `a-${n}`, beautician_id: BIZ, client_id: SOPHIE, starts_at: at(n),
        status: 'confirmed', treatment_id: LAMINATION, extra_treatment_ids: null,
        treatments: db.treatments.find(t => t.id === LAMINATION), clients: db.clients[0] });
    }
    const res = await alerts();
    expect(res.body.alerts).toHaveLength(1);
    expect(res.body.alerts[0].bookings).toBe(3);
  });

  it('shouts rather than showing an empty list when it could not read the diary', async () => {
    failing.set('appointments', { code: '42703', message: 'boom' });
    const res = await alerts();
    failing.clear();
    expect(res.status).toBe(500);
  });
});

/* ============================= the other half of the same dead comparison === */

describe('the swap and add lists were hiding treatments from everybody', () => {
  /* GET .../manage/:token/treatments filtered on the SAME `status === 'passed'`
   * test. Since it was false for every client alive, the only treatments the
   * page would offer were the ones needing no patch test at all - including
   * to a client who had just had that exact treatment. */
  const swapList = () => run(bookingRouter, 'get', '/:slug/manage/:token/treatments', {
    params: { slug: SLUG, token: TOKEN },
  });

  it('offers a patch-test treatment to a client whose record supports it', async () => {
    seedPriorVisit(LAMINATION);
    seedTheBookingSheMoved(WAX);      // booked in for something that needs no test

    const res = await swapList();
    expect(res.body.treatments.map(t => t.id)).toContain(LAMINATION);
  });

  it('and still hides it from someone with nothing behind her', async () => {
    seedTheBookingSheMoved(WAX);
    const res = await swapList();
    expect(res.body.treatments.map(t => t.id)).not.toContain(LAMINATION);
  });

  it('lets her swap into one once Ellie has recorded her test', async () => {
    seedTheBookingSheMoved(WAX);
    await run(appointmentsRouter, 'post', '/patch-test-records', {
      beautician: { id: BIZ }, body: { client_id: SOPHIE, test_date: day(-10) },
    });
    const res = await swapList();
    expect(res.body.treatments.map(t => t.id)).toContain(LAMINATION);
  });

  it('and change-treatment agrees with the list it was offered from', async () => {
    seedPriorVisit(LAMINATION);
    seedTheBookingSheMoved(WAX);
    const res = await run(bookingRouter, 'post', '/:slug/manage/:token/change-treatment', {
      params: { slug: SLUG, token: TOKEN }, body: { treatment_id: LAMINATION },
    });
    expect(res.status).not.toBe(409);
  });
});

/* ================================== an extra is a treatment on the booking == */

describe('a treatment added as an extra is not invisible to the rule', () => {
  it('asks for a patch test when only the EXTRA needs one', async () => {
    // The manage payload read requires_patch_test off the first treatment
    // alone, so a lash tint added to a brow wax was never checked at all.
    seedTheBookingSheMoved(WAX);
    db.appointments[0].extra_treatment_ids = [LAMINATION];

    const res = await manage();
    expect(res.body.patchTest.required).toBe(true);
    expect(res.body.needsPatchTest).toBe(true);
  });

  it('and says nothing at all when no treatment on the booking needs one', async () => {
    seedTheBookingSheMoved(WAX);
    const res = await manage();
    expect(res.body.patchTest.required).toBe(false);
    expect(res.body.patchTest.certainty).toBe('not_required');
    expect(res.body.needsPatchTest).toBe(false);
  });
});
