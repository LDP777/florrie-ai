/**
 * WHO GETS ASKED ABOUT ALLERGIES, AND WHO ACTUALLY GETS STOPPED.
 *
 * At 01:18 on 27 August 2026 a client messaged: "hey I have a appointment on
 * the 3rd of September and I just went onto the website and it said about a
 * patch test do I need to book one in or not x". Investigating that surfaced
 * this, one table over and worse.
 *
 * The booking page decided whether to ask the health questions (allergies,
 * medication, pregnancy, past adverse reactions) from
 * `recognisedClient?.found`, which means only "a clients row matched on email
 * or the last nine digits of the phone". It read "we have a phone number for
 * her" as "she has been here before".
 *
 * MEASURED IN THE PILOT SALON'S LIVE DATABASE
 *   1,151 clients, 926 of them imported from Timely
 *     854 have total_visits > 0
 *     277 have no history of any kind: total_visits 0, last_visit_at NULL, no
 *         completed appointment. Contacts in the old system who never came in.
 * All 926 are `found`, so all 926 skipped the form, the required flag, the
 * server gate, the form SMS and the 24 to 72 hour chase, in that order. And
 * since consultation_responses rows were only ever created by an inline
 * submission from a not-found client or by that same SMS, no imported client
 * could have a form on file at all.
 *
 * THE RULE, from 29 August 2026, is hybrid and lives in
 * lib/consultation-status.js:
 *   requires_consultation treatment: ask unless a COMPLETED response exists
 *     for the form that treatment asks for.
 *   anything else: ask only a client with no prior history.
 * Being asked never blocks, with ONE exception that this file guards first.
 *
 * There were no tests on any of this, and the module that sends and files
 * consultation forms was mocked out wholesale in the two files that drive the
 * booking route. Nothing here mocks it: the real sendConsultationFormSMS and
 * the real recordBookingConsultation run against the fake database, so what
 * this file asserts about a form being sent or filed is the row that would
 * actually exist.
 */
process.env.TZ = 'UTC';   // what src/index.js pins in production, and why.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// The fake database. Small in-memory PostgREST: enough filtering for the rules
// under test, and it records every write so a test can look at what was saved.
// ---------------------------------------------------------------------------

const db = {
  beauticians: [], treatments: [], clients: [], appointments: [], hours_exceptions: [],
  consultation_forms: [], consultation_form_fields: [], consultation_responses: [],
  messages: [], ai_actions: [], patch_tests: [], transactions: [], add_ons: [],
  appointment_add_ons: [], booking_conversations: [], promo_codes: [], gift_vouchers: [],
  client_packages: [], packages: [], membership_subscriptions: [], client_memberships: [],
};
let idCounter = 0;
const nextId = (p) => `${p}_${++idCounter}`;

/* The one embedded join this file needs to be real.
 *
 * recordBookingConsultation pairs answers to questions through
 * consultation_forms -> consultation_form_fields, and a stub that returned the
 * form row with no fields on it would file every answer as "belongs to no
 * question anyone can name". That is the failure mode this file exists to
 * catch, so the join is modelled rather than shrugged at. */
function withJoins(table, row) {
  if (table !== 'consultation_forms') return row;
  return {
    ...row,
    consultation_form_fields: db.consultation_form_fields.filter(f => f.form_id === row.id),
  };
}

function makeBuilder(table) {
  const filters = [];
  let pending = null;
  let head = false;
  let wantCount = false;
  const matching = () => (db[table] || []).filter(r => filters.every(f => f(r)));
  const settle = () => {
    if (pending?.op === 'insert') {
      const payload = Array.isArray(pending.payload) ? pending.payload : [pending.payload];
      const created = payload.map(p => ({
        id: nextId(table), management_token: nextId('mt'),
        created_at: new Date().toISOString(), ...p,
      }));
      db[table].push(...created);
      return { data: created, error: null, count: created.length };
    }
    if (pending?.op === 'upsert') {
      const p = pending.payload;
      const existing = db[table].find(r => r.beautician_id === p.beautician_id && r.client_id === p.client_id);
      if (existing) Object.assign(existing, p);
      else db[table].push({ id: nextId(table), ...p });
      return { data: null, error: null, count: null };
    }
    if (pending?.op === 'update') {
      const rows = matching();
      for (const r of rows) Object.assign(r, pending.payload);
      return { data: rows, error: null, count: rows.length };
    }
    if (pending?.op === 'delete') {
      const gone = new Set(matching());
      db[table] = (db[table] || []).filter(r => !gone.has(r));
      return { data: [...gone], error: null, count: gone.size };
    }
    const rows = matching();
    // head: true is how a caller asks for a count and nothing else. Returning
    // rows there would hide a caller reading `data` when only `count` is set.
    return {
      data: head ? null : rows.map(r => withJoins(table, r)),
      error: null,
      count: wantCount ? rows.length : null,
    };
  };
  const b = {
    select(_cols, opts) { head = !!opts?.head; wantCount = !!opts?.count; return b; },
    insert(p) { pending = { op: 'insert', payload: p }; return b; },
    upsert(p) { pending = { op: 'upsert', payload: p }; return b; },
    update(p) { pending = { op: 'update', payload: p }; return b; },
    delete() { pending = { op: 'delete' }; return b; },
    eq(c, v) { filters.push(r => String(r[c]) === String(v)); return b; },
    neq(c, v) { filters.push(r => String(r[c]) !== String(v)); return b; },
    in(c, v) { filters.push(r => v.map(String).includes(String(r[c]))); return b; },
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
    maybeSingle() { const o = settle(); return Promise.resolve({ ...o, data: (o.data || [])[0] || null }); },
    single() { const o = settle(); return Promise.resolve({ ...o, data: (o.data || [])[0] || null }); },
    then(res, rej) { return Promise.resolve(settle()).then(res, rej); },
    catch(rej) { return Promise.resolve(settle()).catch(rej); },
  };
  return b;
}

vi.mock('../../src/config.js', () => ({ supabase: { from: (t) => makeBuilder(t) } }));

vi.mock('stripe', () => ({
  default: class {
    constructor() {
      this.customers = { create: async () => ({ id: 'cus_fake' }) };
      this.checkout = { sessions: { create: async () => ({
        id: 'cs_fake', url: 'https://checkout.stripe.com/c/pay/cs_fake', payment_intent: 'pi_fake',
      }) } };
      this.paymentIntents = { retrieve: async (id) => ({ id, status: 'requires_payment_method' }) };
    }
  },
}));

// Every text that left the building, so "the form was sent" is an assertion
// about a real message rather than about a stub returning true.
const sentSms = [];
vi.mock('../../src/services/notifications.js', () => ({
  notifyBookingConfirmed: async () => true,
  sendMessage: async () => ({ channel: 'sms' }),
  sendWhatsApp: async () => true,
  sendSMS: async (args) => { sentSms.push(args); return { channel: 'sms' }; },
  sendEmail: async () => true,
  pickChannel: () => 'sms',
}));
vi.mock('../../src/services/push-notifications.js', () => ({
  pushNewBooking: async () => true, pushBookingConfirmed: async () => true,
  pushReschedule: async () => true, pushPatchTestBooked: async () => true,
  pushClientCancelled: async () => true, pushTeamUpdate: async () => true,
}));
vi.mock('../../src/services/live-activity.js', () => ({ refreshLiveActivity: async () => true }));
vi.mock('../../src/services/policy-fees.js', () => ({
  chargePolicyFee: async () => ({ charged: false }),
  computePolicyFee: () => ({ feeCents: 0 }),
  chargeRescheduleDeposit: async () => ({ charged: false, reason: 'no_deposit' }),
}));
vi.mock('../../src/middleware/turnstile.js', () => ({ verifyTurnstile: (_q, _s, next) => next() }));
vi.mock('../../src/middleware/auth.js', () => ({ requireAuth: (_q, _s, next) => next() }));
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

const { supabase } = await import('../../src/config.js');
const bookingRouter = (await import('../../src/routes/booking.js')).default;
const { readConsultationStatus } = await import('../../src/lib/consultation-status.js');
const { advanceBookingConversation } = await import('../../src/services/conversational-booking.js');

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

// ---------------------------------------------------------------------------
// The salon, the clock and the five populations
// ---------------------------------------------------------------------------

const ALL_WEEK = {
  mon: { start: '09:00', end: '18:00' }, tue: { start: '09:00', end: '18:00' },
  wed: { start: '09:00', end: '18:00' }, thu: { start: '09:00', end: '18:00' },
  fri: { start: '09:00', end: '18:00' }, sat: { start: '09:00', end: '18:00' },
  sun: { start: '09:00', end: '18:00' },
};

/* The clock is fixed, not read. Every rule here compares a booking against
 * "now", and a suite that passes in the morning and fails at midnight is worse
 * than no suite. 27 August 2026 at 09:05 UTC is 10:05 on the salon clock in
 * British Summer Time: the morning after the 01:18 message. */
const NOW_UTC = '2026-08-27T09:05:00.000Z';
// Thursday 3 September 2026 at 11:00, salon wall time. The appointment the
// client was asking about at 01:18.
const THE_THIRD = '2026-09-03T11:00:00';

const BEAUTICIAN = {
  id: 'b1', booking_slug: 'ellindigo', business_name: 'Ellindigo', first_name: 'Ellie',
  stripe_account_id: 'acct_1', stripe_onboarding_complete: true,
  booking_policy: {}, payment_settings: {}, working_hours: ALL_WEEK,
  timezone: 'Europe/London', client_reminder_prefs: {},
};

// A tint needs the health questions. A wax does not. That difference is the
// whole hybrid rule.
const TINT = {
  id: 't_tint', beautician_id: 'b1', name: 'Brow tint', duration_minutes: 45,
  buffer_minutes: 0, price_cents: 2000, deposit_cents: 0, deposit_percent: null,
  requires_patch_test: false, requires_consultation: true, consultation_form_id: 'f_brow',
  is_active: true,
};
const WAX = {
  id: 't_wax', beautician_id: 'b1', name: 'Lip wax', duration_minutes: 15,
  buffer_minutes: 0, price_cents: 900, deposit_cents: 0, deposit_percent: null,
  requires_patch_test: false, requires_consultation: false, consultation_form_id: null,
  is_active: true,
};
// A second consultation treatment with its OWN form, so "any completed form
// ever" cannot pass for a consultation.
const LASH = {
  id: 't_lash', beautician_id: 'b1', name: 'Lash lift', duration_minutes: 60,
  buffer_minutes: 0, price_cents: 4500, deposit_cents: 0, deposit_percent: null,
  requires_patch_test: false, requires_consultation: true, consultation_form_id: 'f_lash',
  is_active: true,
};

const FIELD_ALLERGIES = 'fld_allergies';
const FIELD_MEDICAL = 'fld_medical';

/** An imported client row, in the shape the Timely importer actually writes. */
function imported(over = {}) {
  return {
    id: nextId('c'), beautician_id: 'b1', first_name: 'Imported', last_name: 'Client',
    email: null, phone: null, imported_from: 'timely', total_visits: 0,
    last_visit_at: null, blocked_at: null, archived_at: null, stripe_customer_id: null,
    ...over,
  };
}

/**
 * The five populations, exactly as they exist in the pilot salon.
 *
 * Each one is a client plus the treatment she is booking, because "does she
 * need a form" is a question about both.
 */
const POPULATIONS = {
  // Nobody at all. The ONE population that is refused rather than chased.
  stranger: { phone: '07700900999', treatment: TINT, seed: () => null },

  // One of the 277. A row from Timely, no visits, no last visit, nothing.
  importedNeverAttended: {
    phone: '07700900111', treatment: TINT,
    seed: () => db.clients.push(imported({
      id: 'c_never', first_name: 'Never', phone: '07700900111',
      email: 'never@example.com', total_visits: 0, last_visit_at: null,
    })),
  },

  // One of the 854 with real history and no form on file, which before this
  // change was every single one of them.
  importedRegular: {
    phone: '07700900222', treatment: TINT,
    seed: () => db.clients.push(imported({
      id: 'c_reg', first_name: 'Regular', phone: '07700900222',
      email: 'regular@example.com', total_visits: 47, last_visit_at: '2026-07-01T10:30:00.000Z',
    })),
  },

  // The same regular, with the brow form actually completed.
  importedRegularWithForm: {
    phone: '07700900333', treatment: TINT,
    seed: () => {
      db.clients.push(imported({
        id: 'c_done', first_name: 'Done', phone: '07700900333',
        email: 'done@example.com', total_visits: 12, last_visit_at: '2026-08-01T10:30:00.000Z',
      }));
      db.consultation_responses.push({
        id: 'cr_done', form_id: 'f_brow', beautician_id: 'b1', client_id: 'c_done',
        appointment_id: null, token: 'tok_done', answers: { [FIELD_ALLERGIES]: 'None' },
        status: 'completed', completed_at: '2026-08-01T09:00:00.000Z',
      });
    },
  },

  // A regular booking something that asks nothing of her.
  regularOrdinaryTreatment: {
    phone: '07700900444', treatment: WAX,
    seed: () => db.clients.push(imported({
      id: 'c_wax', first_name: 'Waxy', phone: '07700900444',
      email: 'waxy@example.com', total_visits: 9, last_visit_at: '2026-08-10T10:30:00.000Z',
    })),
  },
};

function seedSalon() {
  db.beauticians.push({ ...BEAUTICIAN });
  db.treatments.push({ ...TINT }, { ...WAX }, { ...LASH });
  db.consultation_forms.push(
    { id: 'f_brow', beautician_id: 'b1', name: 'Brow consultation', is_default: true, is_active: true, consent_text: null },
    { id: 'f_lash', beautician_id: 'b1', name: 'Lash consultation', is_default: false, is_active: true, consent_text: null },
  );
  db.consultation_form_fields.push(
    { id: FIELD_ALLERGIES, form_id: 'f_brow', type: 'text', label: 'Any known allergies?', required: true, sort_order: 1 },
    { id: FIELD_MEDICAL, form_id: 'f_brow', type: 'text', label: 'Any medical conditions?', required: true, sort_order: 2 },
  );
}

/** Set up one population and hand back what the tests need to drive it. */
function seed(name) {
  const pop = POPULATIONS[name];
  pop.seed();
  const client = db.clients.find(c => c.phone === pop.phone) || null;
  return { ...pop, client };
}

const lookup = (pop) => run(bookingRouter, 'post', '/:slug/lookup-client', {
  params: { slug: 'ellindigo' },
  body: { phone: pop.phone, treatment_ids: [pop.treatment.id] },
});

/* The form SMS is fired and not awaited, deliberately: a booking must never
 * wait on a text message. So the test drains the microtask queue before
 * looking, rather than racing the very thing the route is careful not to
 * block on. No timers are involved, so this cannot hang. */
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

const book = async (pop, over = {}) => {
  const out = await run(bookingRouter, 'post', '/:slug/book', {
    params: { slug: 'ellindigo' },
    body: {
      treatment_id: pop.treatment.id,
      starts_at: THE_THIRD,
      client_name: 'Ada Booking',
      client_phone: pop.phone,
      payment_type: 'deposit',
      ...over,
    },
  });
  await flush();
  return out;
};

/** The forms that were actually texted out during one test. */
const formsTexted = () => sentSms.filter(m => /consultation form/i.test(m.body || ''));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW_UTC));
  for (const t of Object.keys(db)) db[t] = [];
  sentSms.length = 0;
  idCounter = 0;
  seedSalon();
});

afterEach(() => { vi.useRealTimers(); });

// ---------------------------------------------------------------------------

/**
 * THE LOAD-BEARING SAFETY TEST. DO NOT DELETE THIS DESCRIBE BLOCK.
 *
 * A client who is not in the database at all has never been able to book a
 * treatment that requires a consultation without filling the form in, and she
 * still cannot. Everything else in this file loosened something on purpose.
 * This did not, and if a future change makes these two tests fail then that
 * change has removed a working safety gate rather than the bug it was aiming
 * at.
 */
describe('THE WALL: a client not in the database still cannot book a consultation treatment without the form', () => {
  it('is refused, server side, with nothing written to the diary', async () => {
    const pop = seed('stranger');
    expect(db.clients).toHaveLength(0);

    const out = await book(pop);

    expect(out.status).toBe(400);
    expect(out.body.error).toBe('Please fill in the quick consultation form to book this treatment.');
    // Refused before anything existed. No appointment, and no form texted to
    // somebody who has not booked anything.
    expect(db.appointments).toHaveLength(0);
    expect(formsTexted()).toHaveLength(0);
  });

  it('and the booking page is told to wall her too, before she ever submits', async () => {
    const pop = seed('stranger');
    const out = await lookup(pop);

    expect(out.body.found).toBe(false);
    expect(out.body.consultation.ask).toBe(true);
    expect(out.body.consultation.block).toBe(true);
  });

  it('books the moment she answers the questions', async () => {
    const pop = seed('stranger');

    const out = await book(pop, { consultation: { [FIELD_ALLERGIES]: 'Latex', [FIELD_MEDICAL]: 'None' } });

    expect(out.status).toBe(201);
    expect(db.appointments).toHaveLength(1);
  });

  it('is not walled for a treatment that asks nothing of her, and is still sent the form', async () => {
    // The other arm of the hybrid rule. A first timer booking a lip wax has no
    // prior history, so she is asked, and asking has never been refusing.
    const pop = { ...POPULATIONS.stranger, treatment: WAX };

    const out = await book(pop);

    expect(out.status).toBe(201);
    expect(formsTexted()).toHaveLength(1);
  });
});

describe('the populations the page used to wave through', () => {
  it('an imported contact who has never attended is ASKED, is NOT blocked, and gets the form', async () => {
    const pop = seed('importedNeverAttended');

    const seen = await lookup(pop);
    expect(seen.body.found).toBe(true);
    expect(seen.body.returningClient, 'she has never actually been in').toBe(false);
    expect(seen.body.consultation.ask).toBe(true);
    expect(seen.body.consultation.block, 'chase, never block').toBe(false);

    const out = await book(pop);
    expect(out.status).toBe(201);
    expect(db.appointments).toHaveLength(1);

    // The form went out, and it left behind the PENDING row that the 24 to 72
    // hour pre-appointment reminder chases. Without that row nothing chases.
    expect(formsTexted()).toHaveLength(1);
    const pending = db.consultation_responses.filter(r => r.status === 'pending');
    expect(pending).toHaveLength(1);
    expect(pending[0].client_id).toBe('c_never');
    expect(pending[0].form_id).toBe('f_brow');
  });

  it('an imported regular with real history and no form on file is ASKED, and not blocked', async () => {
    const pop = seed('importedRegular');

    const seen = await lookup(pop);
    expect(seen.body.returningClient, 'she is one of the 854').toBe(true);
    // The hybrid rule: a consultation treatment asks a regular too, because
    // being a regular is not a consultation form.
    expect(seen.body.consultation.ask).toBe(true);
    expect(seen.body.consultation.block).toBe(false);

    const out = await book(pop);
    expect(out.status).toBe(201);
    expect(formsTexted()).toHaveLength(1);
  });

  it('an imported regular with a COMPLETED form for that treatment is not asked again', async () => {
    const pop = seed('importedRegularWithForm');

    const seen = await lookup(pop);
    expect(seen.body.consultation.ask).toBe(false);
    expect(seen.body.consultation.formOnFile).toBe(true);

    const out = await book(pop);
    expect(out.status).toBe(201);
    expect(formsTexted(), 'she has already told us all this').toHaveLength(0);
  });

  it('a completed form for a DIFFERENT treatment is not a consultation', async () => {
    // She filled in the brow form in the fixture. This is a lash lift, which
    // asks its own form, and no allergy answers exist for it.
    const pop = { ...seed('importedRegularWithForm'), treatment: LASH };

    const seen = await lookup(pop);
    expect(seen.body.consultation.ask).toBe(true);
    expect(seen.body.consultation.formOnFile).toBe(false);
  });

  it('a regular booking an ordinary treatment is not asked anything', async () => {
    const pop = seed('regularOrdinaryTreatment');

    const seen = await lookup(pop);
    expect(seen.body.consultation.ask).toBe(false);
    expect(seen.body.consultation.needsConsultation).toBe(false);

    const out = await book(pop);
    expect(out.status).toBe(201);
    expect(formsTexted()).toHaveLength(0);
  });

  it('an imported contact with no history IS asked for an ordinary treatment', async () => {
    // The second arm of the hybrid rule, and the reason it is hybrid: she has
    // a row, so the old `found` test skipped her, and she has never been in.
    const pop = { ...seed('importedNeverAttended'), treatment: WAX };

    const seen = await lookup(pop);
    expect(seen.body.consultation.ask).toBe(true);
    expect(seen.body.consultation.block).toBe(false);
  });
});

/**
 * The booking page reads its verdict off POST /lookup-client. Florrie reads
 * hers inside conversational-booking. Both come from
 * lib/consultation-status.js, and this is the test that says so: for the same
 * client and the same treatment, the shared function, the endpoint the page
 * obeys, and what Florrie actually does in a DM all have to line up.
 *
 * Nothing here restates the rule. The expected value is whatever the shared
 * module says, so this file cannot drift from the code by agreeing with an
 * out of date copy of it.
 */
describe('the booking page and Florrie reach the same verdict', () => {
  const CASES = ['importedNeverAttended', 'importedRegular', 'importedRegularWithForm', 'regularOrdinaryTreatment'];

  for (const name of CASES) {
    it(`agree about ${name}`, async () => {
      const pop = seed(name);

      const shared = await readConsultationStatus(supabase, {
        beauticianId: 'b1',
        clientId: pop.client.id,
        treatments: [pop.treatment],
        inDatabase: true,
      });

      // 1. What the booking page is told.
      const seen = await lookup(pop);
      expect(seen.body.consultation.ask).toBe(shared.ask);
      expect(seen.body.consultation.block).toBe(shared.block);

      // 2. What Florrie does about the same booking in a DM. She refuses to
      //    take a deposit for a treatment whose consultation is outstanding
      //    and sends the client to the booking page instead, so "did she hand
      //    over about the form" is her answer to the same question.
      const florrie = await florrieVerdict(pop);
      expect(florrie.sentHerToTheForm).toBe(shared.ask && shared.needsConsultation);
    });
  }

  /**
   * Walk Florrie through picking a time for this client and this treatment,
   * and report whether she handed over about the health form.
   */
  async function florrieVerdict(pop) {
    db.booking_conversations.length = 0;
    const args = {
      beautician: { ...BEAUTICIAN },
      client: { id: pop.client.id, first_name: pop.client.first_name },
      classification: { intent: 'booking_request', confidence: 1 },
      context: { treatments: db.treatments, treatmentsError: null, patchTest: null },
    };
    const offered = await advanceBookingConversation({ ...args, message: `can I book a ${pop.treatment.name} please` });
    const time = offered?.allowedTimes?.[0];
    // "She never got as far as picking a time" must never read as "she decided
    // no form was needed". A verdict that was never reached is not a verdict.
    expect(time, `Florrie offered no time, so there is no verdict to compare: ${offered?.reply}`).toBeTruthy();
    const picked = await advanceBookingConversation({ ...args, message: `${time} please` });
    return {
      sentHerToTheForm: /health form/i.test(picked?.reply || ''),
      reply: picked?.reply || null,
    };
  }
});

/**
 * The answers she types have to survive the journey.
 *
 * The booking page used to send `!recognisedClient?.found ? answers : null`,
 * so for all 926 imported clients the answers were nulled on the way out even
 * where the page had collected them. Nothing reached consultation_responses,
 * and a form nobody can read is a form nobody filled in.
 */
describe('answers given at booking are filed, for everybody who is asked', () => {
  it('files a completed response for an imported regular, keyed to the right form', async () => {
    const pop = seed('importedRegular');

    const out = await book(pop, {
      consultation: { [FIELD_ALLERGIES]: 'Nut oils', [FIELD_MEDICAL]: 'None' },
    });

    expect(out.status).toBe(201);
    const completed = db.consultation_responses.filter(r => r.status === 'completed');
    expect(completed, 'her answers never reached consultation_responses').toHaveLength(1);
    expect(completed[0].form_id).toBe('f_brow');
    expect(completed[0].client_id).toBe('c_reg');
    expect(completed[0].appointment_id).toBe(db.appointments[0].id);
    expect(completed[0].answers[FIELD_ALLERGIES]).toBe('Nut oils');

    // Answered inline, so she is not texted the same form ten seconds later.
    expect(formsTexted()).toHaveLength(0);
  });

  it('files them for an imported contact who has never attended too', async () => {
    const pop = seed('importedNeverAttended');

    await book(pop, { consultation: { [FIELD_ALLERGIES]: 'Latex', [FIELD_MEDICAL]: 'Asthma' } });

    const completed = db.consultation_responses.filter(r => r.status === 'completed');
    expect(completed).toHaveLength(1);
    expect(completed[0].answers[FIELD_MEDICAL]).toBe('Asthma');
  });

  it('a filed answer is what suppresses the next ask, which is the whole loop', async () => {
    const pop = seed('importedRegular');
    await book(pop, { consultation: { [FIELD_ALLERGIES]: 'Nut oils', [FIELD_MEDICAL]: 'None' } });

    // Same client, same treatment, second booking. She has told us once.
    const again = await lookup(pop);
    expect(again.body.consultation.ask).toBe(false);
  });
});

/**
 * THE MANAGE PAGE. Change-treatment and add-treatment handled patch tests and
 * did nothing at all about consultation forms, so a client could book a wax,
 * open the link in her confirmation text, swap it for a tint, and no
 * consultation was asked of anybody. Chase, not block: the swap goes through
 * and the form follows it.
 */
describe('swapping or adding a treatment from the confirmation link', () => {
  function seedBooking(clientId, treatmentId) {
    db.appointments.push({
      id: 'a_manage', beautician_id: 'b1', client_id: clientId, management_token: 'mt_manage',
      status: 'confirmed', treatment_id: treatmentId, extra_treatment_ids: [],
      starts_at: THE_THIRD, ends_at: '2026-09-03T11:15:00', duration_minutes: 15,
      buffer_minutes: 0, extra_padding_minutes: 0, price_cents: 900,
      deposit_cents: 0, deposit_paid: false,
      clients: { first_name: 'Waxy' },
      treatments: { id: treatmentId, name: 'Lip wax', duration_minutes: 15, price_cents: 900, requires_patch_test: false },
      beauticians: {
        id: 'b1', booking_slug: 'ellindigo', business_name: 'Ellindigo', first_name: 'Ellie',
        working_hours: ALL_WEEK, timezone: 'Europe/London', patch_test_expiry_months: 6,
      },
    });
  }

  it('swapping a wax for a tint sends the form and lets the swap through', async () => {
    seed('regularOrdinaryTreatment');
    seedBooking('c_wax', 't_wax');

    const out = await run(bookingRouter, 'post', '/:slug/manage/:token/change-treatment', {
      params: { slug: 'ellindigo', token: 'mt_manage' }, body: { treatment_id: 't_tint' },
    });

    expect(out.status).toBe(200);
    expect(out.body.success).toBe(true);
    expect(db.appointments[0].treatment_id, 'chase, not block: the swap stands').toBe('t_tint');
    expect(formsTexted()).toHaveLength(1);
    expect(out.body.consultationFormSent).toBe(true);
    expect(out.body.message).toContain('health form');
  });

  it('adding a tint to a wax booking sends the form and lets the add through', async () => {
    seed('regularOrdinaryTreatment');
    seedBooking('c_wax', 't_wax');

    const out = await run(bookingRouter, 'post', '/:slug/manage/:token/add-treatment', {
      params: { slug: 'ellindigo', token: 'mt_manage' }, body: { treatment_id: 't_tint' },
    });

    expect(out.status).toBe(200);
    expect(db.appointments[0].extra_treatment_ids).toContain('t_tint');
    expect(formsTexted()).toHaveLength(1);
  });

  it('says nothing to a client who has already completed that form', async () => {
    seed('importedRegularWithForm');
    seedBooking('c_done', 't_wax');

    const out = await run(bookingRouter, 'post', '/:slug/manage/:token/change-treatment', {
      params: { slug: 'ellindigo', token: 'mt_manage' }, body: { treatment_id: 't_tint' },
    });

    expect(out.status).toBe(200);
    expect(formsTexted()).toHaveLength(0);
    expect(out.body.message).not.toContain('health form');
  });

  it('does not text the same form twice when one is already outstanding', async () => {
    seed('regularOrdinaryTreatment');
    db.consultation_responses.push({
      id: 'cr_pending', form_id: 'f_brow', beautician_id: 'b1', client_id: 'c_wax',
      appointment_id: 'a_manage', token: 'tok_pending', status: 'pending',
    });
    seedBooking('c_wax', 't_wax');

    await run(bookingRouter, 'post', '/:slug/manage/:token/change-treatment', {
      params: { slug: 'ellindigo', token: 'mt_manage' }, body: { treatment_id: 't_tint' },
    });

    expect(formsTexted()).toHaveLength(0);
  });
});

/**
 * The page cannot be driven from here (there is no DOM in this suite), but the
 * two lines that caused the defect can be pinned so they do not come back.
 *
 * Both were `recognisedClient?.found`, which is only ever "a clients row
 * matched on email or the last nine digits of the phone": one chose whether to
 * show the form at all, the other nulled the answers on the way to the server
 * even where the page had collected them. Between them, no client imported
 * from Timely could be asked the health questions or have an answer filed.
 */
describe('the booking page obeys the server rather than its own copy of the rule', () => {
  const page = readFileSync(new URL('../../../frontend/src/pages/BookingPage.jsx', import.meta.url), 'utf8');

  it('no longer decides who gets the form from `found`', () => {
    expect(page).not.toContain('const askForms = !recognisedClient?.found');
    expect(page).not.toContain('!recognisedClient?.found ? consultationAnswers : null');
    // It waits for the verdict instead of reading state a blur handler is
    // still filling in. That await IS the race fix.
    expect(page).toContain('await resolveConsultationDecision()');
  });

  it('sends the answers it collected', () => {
    expect(page).toContain('consultation: consultationSubmission');
  });

  it('gives the consultation step a dot and a label of its own', () => {
    expect(page).toContain("CONSULTATION_STEP = { label: 'Health form', at: 2.5 }");
    expect(page).toContain('CONSULTATION_STEP');
  });

  it('claims nothing legal about consultation forms, anywhere a client or an owner reads', () => {
    const compliance = readFileSync(new URL('../../../frontend/src/pages/Compliance.jsx', import.meta.url), 'utf8');
    // "Consultation forms protect you legally for every client" was an
    // unsourced legal claim sitting in the same paragraph where the patch test
    // claim had already had to be corrected from a false "UK law requires 48h".
    for (const src of [compliance, page]) {
      expect(src).not.toMatch(/protect you legally/i);
      expect(src).not.toMatch(/legally required/i);
      expect(src).not.toMatch(/law requires/i);
    }
    expect(compliance).toContain('what your insurer expects you to hold');
  });
});
