/**
 * "IT DOESN'T LET ME SEE YOUR SLOTS, I JUST HAVE TO CHOOSE A TIME AND DATE."
 *
 * A real client, in a real conversation, about a real reschedule link:
 *
 *   "It does but it doesn't let me see your slots, I just have to choose a
 *    time and date and it keeps saying it's not available but that's cause
 *    I'm guessing haha x"
 *
 * Ellie then read the diary herself and told her a time that worked. The
 * product did nothing. The good picker existed, gated behind
 * booking_policy.reschedule_between_only, a flag almost nobody sets; the
 * DEFAULT path was a date box, a time box and a client guessing, and every
 * guess that missed came back as a rejection from the server.
 *
 * So the endpoint has two modes now, and this file is mostly about one
 * question: IS WHAT IT OFFERS ACTUALLY BOOKABLE?
 *
 * The important test here does not ask getFreeSlots whether its own answer was
 * right. It parses the times back out of the HTTP response and checks each one
 * against the seeded diary with `bookable()` below, an independent reading of
 * working hours, closures, blocks and existing bookings that shares no code
 * with the generator. A test written against the generator agrees with the
 * generator's bugs. Same discipline as booking-walkthrough.test.js.
 *
 * The last test in that group goes one better and posts the offered time back
 * to POST .../reschedule, the same route the client's tap hits, and requires it
 * to be accepted. That is the client's complaint, expressed as an assertion.
 *
 * Also here, because it is the same class of defect and sits in the same file:
 * hours_exceptions.end_date is written by the UI and read by almost nobody, so
 * a closure entered as 24 to 30 August closed the 24th and left the rest of the
 * holiday on sale. lib/free-slots.js and the /book guard were fixed; the two
 * PUBLIC readers, GET /:slug/availability and GET /:slug/availability-range,
 * were missed, so the booking page still showed a week of a holiday as open.
 */
process.env.TZ = 'UTC';   // what src/index.js pins in production, and why.

import { describe, it, expect, beforeEach, vi } from 'vitest';

/* ------------------------------------------------------------------ schema --
 * Same discipline as booking-column-truth.test.js: PostgREST rejects the WHOLE
 * select if one column in it does not exist, and it reports that by RESOLVING
 * with { data: null, error }. A stub that hands back rows whatever you ask for
 * cannot catch that, and both fixes here ADD columns to existing selects
 * (appointments.id to the free-slots busy query, hours_exceptions.end_date to
 * the two availability readers). Column lists copied from supabase/migrations.
 */
const COLUMNS = {
  appointments: [
    // 001_initial_schema.sql
    'id', 'beautician_id', 'client_id', 'treatment_id', 'starts_at', 'ends_at',
    'duration_minutes', 'buffer_minutes', 'extra_padding_minutes', 'status',
    'price_cents', 'deposit_cents', 'deposit_paid', 'no_show_fee_cents',
    'no_show_fee_charged', 'booked_via', 'ai_booked', 'ai_action_id',
    'cancelled_at', 'cancellation_reason', 'client_notes', 'beautician_notes',
    'created_at', 'updated_at',
    // later migrations (007, 017, 029, 030, 034, 037, 041, 042, 043, ...)
    'client_email', 'client_package_id', 'completed_at', 'deposit_amount_cents',
    'deposit_percent', 'deposit_status', 'discount_cents', 'discount_meta',
    'extra_treatment_ids', 'form_url', 'google_event_id', 'late_cancel_charged',
    'late_reschedule_charged', 'location_id', 'management_token',
    'no_show_fee_payment_intent', 'no_showed_at', 'package_redemption',
    'patch_test_duration_minutes', 'patch_test_price_cents', 'payment_expires_at',
    'payment_method', 'payment_type', 'photo_consent', 'policy_fee_amount_cents',
    'policy_fee_charged_at', 'policy_fee_payment_intent_id', 'policy_snapshot',
    'rescheduled_at', 'rescheduled_from', 'stripe_payment_intent_id',
    'stripe_payment_method_id', 'xero_connected',
  ],
  hours_exceptions: [
    // 007_all_features.sql
    'id', 'beautician_id', 'date', 'is_closed', 'custom_start', 'custom_end',
    'reason', 'created_at',
    // 008_hours_exceptions_updates.sql, 027_multi_location.sql
    'type', 'end_date', 'start_time', 'end_time', 'note', 'notify_clients',
    'location_id',
  ],
};

// Embedded resources PostgREST would resolve by foreign key.
const RELATIONS = {
  appointments: {
    beauticians: { table: 'beauticians', fk: 'beautician_id' },
    treatments: { table: 'treatments', fk: 'treatment_id' },
    clients: { table: 'clients', fk: 'client_id' },
  },
};

const db = {
  beauticians: [], treatments: [], clients: [], appointments: [],
  hours_exceptions: [], transactions: [], patch_tests: [],
  consultation_responses: [], waitlist: [], notifications: [],
  outbound_sends: [], ai_actions: [],
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
  code: '42703',
  message: `column ${table}.${col} does not exist`,
  details: null, hint: null,
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
  let sort = null;

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
    if (failing.has(table)) return { data: null, error: failing.get(table) };
    if (selectError) return { data: null, error: selectError };
    if (pending?.op === 'insert') {
      const payload = Array.isArray(pending.payload) ? pending.payload : [pending.payload];
      const created = payload.map(p => ({ id: nextId(table), management_token: nextId('mt'), ...p }));
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
      db[table] = (db[table] || []).filter(r => !filters.every(f => f(r)));
      return { data: gone, error: null };
    }
    let rows = matching();
    if (sort) rows = [...rows].sort((a, b) => (String(a[sort.col]) < String(b[sort.col]) ? -1 : 1) * (sort.asc ? 1 : -1));
    return { data: withEmbeds(rows), error: null };
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
    upsert(p) { pending = { op: 'insert', payload: p }; return b; },
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
    ilike() { return b; },
    gte(c, v) { filters.push(r => String(r[c]) >= String(v)); return b; },
    lte(c, v) { filters.push(r => String(r[c]) <= String(v)); return b; },
    gt(c, v) { filters.push(r => String(r[c]) > String(v)); return b; },
    lt(c, v) { filters.push(r => String(r[c]) < String(v)); return b; },
    order(col, o = {}) { sort = { col, asc: o.ascending !== false }; return b; },
    limit() { return b; },
    maybeSingle() { const o = settle(); return Promise.resolve(o.error ? o : { data: (o.data || [])[0] || null, error: null }); },
    single() { const o = settle(); return Promise.resolve(o.error ? o : { data: (o.data || [])[0] || null, error: null }); },
    then(res, rej) { return Promise.resolve(settle()).then(res, rej); },
    catch(rej) { return Promise.resolve(settle()).catch(rej); },
  };
  return b;
}

vi.mock('../../src/config.js', () => ({ supabase: { from: (t) => makeBuilder(t) } }));

/* ------------------------------------------------------------------- mocks -- */
vi.mock('stripe', () => ({
  default: class {
    constructor() {
      this.customers = { create: async () => ({ id: 'cus_fake' }) };
      this.checkout = { sessions: { create: async () => ({ id: 'cs_fake', url: 'https://x', payment_intent: 'pi_fake' }) } };
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
vi.mock('../../src/lib/outbound-guard.js', () => ({ guardedSend: async () => ({ sent: false }) }));
vi.mock('@sentry/node', () => ({ captureMessage: () => {}, captureException: () => {} }));

process.env.STRIPE_SECRET_KEY = 'sk_test_x';
process.env.FRONTEND_URL = 'https://florrie.ai';

const bookingRouter = (await import('../../src/routes/booking.js')).default;

/** Drive one route handler straight, no HTTP server, no middleware. */
async function run(method, path, req) {
  const layer = bookingRouter.stack.find(l => l.route?.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`no ${method} ${path}`);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const out = { status: 200, body: null };
  const res = {
    status(c) { out.status = c; return res; },
    json(p) { out.body = p; return res; },
    redirect() { return res; },
    get() { return 'api.florrie.ai'; },
  };
  await handler({ headers: {}, get: () => 'api.florrie.ai', query: {}, body: {}, params: {}, ...req }, res);
  return out;
}

/* -------------------------------------------------------------- wall frame --
 * starts_at and hours_exceptions.date store SALON WALL TIME in a UTC slot, so
 * every helper here reads with slice() and getUTC*, never getHours().
 */
const ALL_WEEK = {
  mon: { start: '09:00', end: '17:00' }, tue: { start: '09:00', end: '17:00' },
  wed: { start: '09:00', end: '17:00' }, thu: { start: '09:00', end: '17:00' },
  fri: { start: '09:00', end: '17:00' }, sat: { start: '09:00', end: '17:00' },
  sun: null,
};
const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const wallNow = () => new Date();                 // TZ is pinned to UTC above
const shift = (days) => {
  const d = new Date(wallNow().getTime() + days * 24 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
};
/** A dated day N days out that is NOT a Sunday, so the salon is open on it. */
function openDay(minDaysAhead) {
  let n = minDaysAhead;
  for (;;) {
    const day = shift(n);
    if (new Date(`${day}T12:00:00Z`).getUTCDay() !== 0) return day;
    n += 1;
  }
}
const at = (day, hhmm) => `${day}T${hhmm}:00`;
const mins = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/* ------------------------------------------------------------- the verifier --
 * A SECOND, INDEPENDENT READING OF THE DIARY.
 *
 * This shares no code with lib/free-slots.js. It walks the seeded rows in plain
 * wall minutes and answers one question: could a person actually have this
 * time? If the endpoint and this disagree, the endpoint is wrong, and that is
 * the whole point of writing it twice.
 */
function bookable(wallIso, { beauticianId, totalMinutes, exceptAppointmentId, workingHours = ALL_WEEK }) {
  const day = wallIso.slice(0, 10);
  const start = mins(wallIso.slice(11, 16));
  const end = start + totalMinutes;
  const why = (r) => ({ ok: false, why: `${wallIso}: ${r}` });

  // 1. Is she even open, and does the whole appointment fit inside the day?
  const hours = workingHours[DOW[new Date(`${day}T12:00:00Z`).getUTCDay()]];
  if (!hours || !hours.start || !hours.end) return why('the salon is closed that weekday');
  if (start < mins(hours.start)) return why(`starts before ${hours.start}`);
  if (end > mins(hours.end)) return why(`runs past ${hours.end}`);

  // 2. Closures and blocks, honouring date..end_date as a RANGE.
  for (const ex of db.hours_exceptions.filter(r => r.beautician_id === beauticianId)) {
    const from = String(ex.date).slice(0, 10);
    const to = (String(ex.end_date || '').slice(0, 10) >= from) ? String(ex.end_date).slice(0, 10) : from;
    if (day < from || day > to) continue;
    const timed = ex.type !== 'closed' && ex.start_time && ex.end_time;
    if (!timed) return why(`falls inside the closure ${from}..${to}`);
    const blockStart = mins(String(ex.start_time));
    const blockEnd = mins(String(ex.end_time));
    if (start < blockEnd && end > blockStart) {
      return why(`overlaps the block ${ex.start_time}-${ex.end_time}`);
    }
  }

  // 3. The real diary. The appointment being MOVED does not count against its
  //    own replacement; anything else live does.
  const dead = ['cancelled', 'cancelled_by_client', 'cancelled_by_beautician', 'no_show'];
  for (const a of db.appointments) {
    if (a.beautician_id !== beauticianId) continue;
    if (a.id === exceptAppointmentId) continue;
    if (dead.includes(a.status)) continue;
    if (String(a.starts_at).slice(0, 10) !== day) continue;
    const aStart = mins(String(a.starts_at).slice(11, 16));
    const aEnd = mins(String(a.ends_at).slice(11, 16));
    if (start < aEnd && end > aStart) return why(`clashes with the ${String(a.starts_at).slice(11, 16)} booking`);
  }

  return { ok: true };
}

/** Every reason the offered list is not bookable, as readable strings. */
const unbookable = (slots, opts) =>
  slots.map(s => bookable(s, opts)).filter(v => !v.ok).map(v => v.why);

/* ------------------------------------------------------------------- seeds -- */
const TOKEN = 'tok-abc';
const APPT_ID = 'a-moving';

function seed({ policy = {}, workingHours = ALL_WEEK, apptDay, apptTime = '13:00', durationMinutes = 60 } = {}) {
  db.beauticians.push({
    id: 'b1', booking_slug: 'ellindigo', business_name: 'Ellindigo', first_name: 'Ellie',
    phone: '07700 900123', email: 'ellie@example.com', timezone: 'Europe/London',
    working_hours: workingHours, booking_policy: policy, payment_settings: {},
    brand_color: '#C76B8A', patch_test_expiry_months: 6, patch_test_block_booking: false,
    stripe_onboarding_complete: true, stripe_account_id: 'acct_1',
  });
  db.treatments.push({
    id: 't1', beautician_id: 'b1', name: 'Hybrid stain', duration_minutes: durationMinutes,
    buffer_minutes: 0, price_cents: 8000, deposit_cents: 2000, requires_patch_test: false,
  });
  db.clients.push({
    id: 'c1', beautician_id: 'b1', first_name: 'Charlotte', last_name: 'Scott',
    email: 'charlotte@example.com', phone: '07700900999',
  });
  const day = apptDay || openDay(7);
  db.appointments.push({
    id: APPT_ID, beautician_id: 'b1', client_id: 'c1', treatment_id: 't1',
    management_token: TOKEN, status: 'confirmed',
    starts_at: at(day, apptTime),
    ends_at: at(day, `${String(Math.floor((mins(apptTime) + durationMinutes) / 60)).padStart(2, '0')}:${String((mins(apptTime) + durationMinutes) % 60).padStart(2, '0')}`),
    duration_minutes: durationMinutes, buffer_minutes: 0, extra_padding_minutes: 0,
    price_cents: 8000, policy_snapshot: policy, rescheduled_at: null,
  });
  return { day };
}

/** Another client's booking, so the diary is not empty. */
function otherBooking(day, from, to, over = {}) {
  db.appointments.push({
    id: nextId('other'), beautician_id: 'b1', client_id: 'c1', treatment_id: 't1',
    status: 'confirmed', starts_at: at(day, from), ends_at: at(day, to),
    duration_minutes: mins(to) - mins(from), buffer_minutes: 0, extra_padding_minutes: 0,
    price_cents: 8000, ...over,
  });
}

const SLOTS_PATH = '/:slug/manage/:token/reschedule/slots';
const getSlots = () => run('get', SLOTS_PATH, { params: { slug: 'ellindigo', token: TOKEN } });

beforeEach(() => {
  for (const t of Object.keys(db)) db[t] = [];
  failing.clear();
  idCounter = 0;
});

/* ================================================== 1. the default mode ===== */

describe('the default reschedule mode offers real, pickable times', () => {
  it('answers with a list instead of nothing at all', async () => {
    // The complaint, reproduced: no reschedule_between_only, so this is the
    // path every ordinary salon's clients land on. Before the fix this ran the
    // back-to-back generator, whose candidate days are ONLY days that already
    // hold a booking, and handed back an empty list for the page to replace
    // with a date box and a time box.
    seed();
    const out = await getSlots();

    expect(out.status).toBe(200);
    expect(out.body.mode).toBe('available');
    expect(out.body.slots.length,
      'the default mode returned no times, so the client is back to guessing').toBeGreaterThan(0);
  });

  it('every time it offers is genuinely free, checked against the diary directly', async () => {
    // A properly busy week, so there is something real to get wrong.
    const { day } = seed({ apptTime: '13:00' });
    const d1 = openDay(2), d2 = openDay(5), d3 = openDay(9);
    otherBooking(d1, '09:00', '11:00');
    otherBooking(d1, '14:30', '16:00');
    otherBooking(d2, '10:00', '12:30');
    otherBooking(d3, '09:00', '17:00');            // a full day
    otherBooking(d2, '13:00', '14:00', { status: 'cancelled_by_client' }); // must NOT hold the time
    db.hours_exceptions.push({
      id: 'he1', beautician_id: 'b1', date: openDay(12), end_date: openDay(16),
      type: 'closed', is_closed: true, start_time: null, end_time: null, reason: 'holiday',
    });
    db.hours_exceptions.push({
      id: 'he2', beautician_id: 'b1', date: openDay(3), end_date: null,
      type: 'amended', is_closed: false, start_time: '12:00', end_time: '15:00', reason: 'dentist',
    });

    const out = await getSlots();
    expect(out.status).toBe(200);
    const slots = out.body.slots;
    expect(slots.length).toBeGreaterThan(0);

    // THE CHECK THAT MATTERS. Not "does getFreeSlots agree with itself".
    const bad = unbookable(slots, {
      beauticianId: 'b1', totalMinutes: 60, exceptAppointmentId: APPT_ID,
    });
    expect(bad, `the endpoint offered ${bad.length} time(s) nobody could have:\n  ${bad.join('\n  ')}`).toEqual([]);

    // And the closed things really were in range, so the check above had work
    // to do rather than passing on an empty diary.
    expect(slots.some(s => s.slice(0, 10) === d1)).toBe(true);
    // A day with nothing in the diary at all must be offered too. This is the
    // half the old back-to-back generator could never reach: its candidate days
    // were only days that ALREADY held a booking, so a quiet week was invisible.
    const quiet = openDay(7) === d1 || openDay(7) === d2 ? openDay(8) : openDay(7);
    expect(db.appointments.filter(a => String(a.starts_at).slice(0, 10) === quiet && a.id !== APPT_ID)).toEqual([]);
    expect(slots.some(s => s.slice(0, 10) === quiet),
      `${quiet} has an empty diary and was offered nothing`).toBe(true);
    expect(slots.some(s => s.slice(0, 10) === d3), 'a fully booked day was offered').toBe(false);
    expect(slots.some(s => s.slice(0, 10) === openDay(14)), 'a day inside the holiday was offered').toBe(false);
    expect(day).toBeTruthy();
  });

  it('offers the time in exactly the shape POST /reschedule accepts', async () => {
    seed();
    const { body } = await getSlots();
    expect(body.slots.length).toBeGreaterThan(0);
    // Zone-free wall time. The route refuses anything carrying an offset, so a
    // full ISO string would be rejected the moment the client tapped it.
    for (const s of body.slots) {
      expect(s, `${s} is not a bare wall-time string`).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    }
  });

  it('the time it offers is one the reschedule route will actually take', async () => {
    // The client's whole complaint, as an assertion: she taps a time she was
    // shown, and it must not come back "that time is not available".
    seed({ apptTime: '13:00' });
    const day = openDay(4);          // deliberately a day with an EMPTY diary

    const { body } = await getSlots();
    const offered = body.slots.find(s => s.slice(0, 10) === day);
    expect(offered, `nothing was offered on ${day}, a completely free day`).toBeTruthy();

    const moved = await run('post', '/:slug/manage/:token/reschedule', {
      params: { slug: 'ellindigo', token: TOKEN },
      body: { new_starts_at: offered },
    });
    expect(moved.status, `the route refused a slot it had just offered: ${JSON.stringify(moved.body)}`).toBe(200);
    expect(moved.body.success).toBe(true);
  });

  it('groups into more than one day, so the picker has a calendar to draw', async () => {
    seed();
    const { body } = await getSlots();
    const days = new Set(body.slots.map(s => s.slice(0, 10)));
    expect(days.size).toBeGreaterThan(1);
    expect(body.horizonDays).toBeGreaterThan(0);
    expect(body.durationMinutes).toBe(60);
  });
});

/* ============================ 2. it must not block its own replacement ====== */

describe('the appointment being moved does not block its own replacement', () => {
  it('offers a half-hour shift when hers is the only booking in the diary', async () => {
    // The plainest version. Nothing else is booked that week, so the ONLY row
    // that could stop 13:30 is Charlotte's own 13:00-14:00.
    const day = openDay(6);
    seed({ apptDay: day, apptTime: '13:00' });

    const { body } = await getSlots();
    const onDay = body.slots.filter(s => s.slice(0, 10) === day);
    expect(onDay).toContain(at(day, '13:30'));
    expect(onDay).toContain(at(day, '13:00'));
  });

  it('offers a half-hour shift of the very booking being moved', async () => {
    // Charlotte has 13:00-14:00 and wants 13:30. The only thing standing in the
    // way of 13:30 is her own booking. getFreeSlots had no exclude option, so
    // without one this is the one time she cannot have.
    const day = openDay(6);
    seed({ apptDay: day, apptTime: '13:00' });
    // Box the day in so 13:00-14:30 is the only room left. If her own booking
    // counted, the day would offer nothing at all.
    otherBooking(day, '09:00', '13:00');
    otherBooking(day, '14:30', '17:00');

    const { body } = await getSlots();
    const onDay = body.slots.filter(s => s.slice(0, 10) === day);

    expect(onDay, 'her own booking blocked every replacement for it').not.toEqual([]);
    expect(onDay).toContain(at(day, '13:30'));
    expect(onDay).toContain(at(day, '13:00'));   // staying put is a valid answer
    // 14:00 would run to 15:00, straight through the 14:30 booking.
    expect(onDay).not.toContain(at(day, '14:00'));

    const bad = unbookable(onDay, { beauticianId: 'b1', totalMinutes: 60, exceptAppointmentId: APPT_ID });
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('still counts everybody ELSE, exclusion is one row not a free pass', async () => {
    const day = openDay(6);
    seed({ apptDay: day, apptTime: '13:00' });
    otherBooking(day, '10:00', '12:00');

    const { body } = await getSlots();
    const onDay = body.slots.filter(s => s.slice(0, 10) === day);
    for (const t of ['10:00', '10:30', '11:00', '11:30']) {
      expect(onDay, `${t} was offered over somebody else's booking`).not.toContain(at(day, t));
    }
  });
});

/* ================================== 3. the back-to-back rule is untouched === */

describe('reschedule_between_only still means back-to-back only', () => {
  it('offers only slots that butt against another booking, not the whole diary', async () => {
    const day = openDay(6);
    seed({ policy: { reschedule_between_only: true }, apptDay: day, apptTime: '13:00' });
    otherBooking(day, '10:00', '11:00');

    const { body } = await getSlots();
    // Deliberate product rule: 11:00 (straight after) and 09:00 (ending exactly
    // when the 10:00 starts) are the only candidates on the day.
    expect(body.slots).toContain(at(day, '11:00'));
    expect(body.slots).toContain(at(day, '09:00'));
    expect(body.slots).not.toContain(at(day, '12:00'));
    expect(body.slots).not.toContain(at(day, '15:00'));
    // And nothing at all on a day with no bookings to butt against.
    expect(body.slots.every(s => s.slice(0, 10) === day)).toBe(true);
    // Response shape unchanged: no mode field, no general-mode extras.
    expect(body.mode).toBeUndefined();
  });

  it('does not let the moved booking act as its own neighbour', async () => {
    // Her 13:00-14:00 must not generate a 14:00 candidate by butting against
    // itself. That is why the back-to-back path excludes it too.
    const day = openDay(6);
    seed({ policy: { reschedule_between_only: true }, apptDay: day, apptTime: '13:00' });

    const { body } = await getSlots();
    expect(body.slots).toEqual([]);
  });
});

/* ================================================== 4. policy is honoured === */

describe('the general list honours the policy the same way the route does', () => {
  it('never offers a date beyond max_advance_days', async () => {
    seed({ policy: { max_advance_days: 3 } });
    const { body } = await getSlots();
    expect(body.slots.length).toBeGreaterThan(0);
    const horizon = new Date();
    horizon.setDate(horizon.getDate() + 3);
    for (const s of body.slots) {
      expect(new Date(`${s}Z`) <= horizon, `${s} is past the ${3}-day booking window`).toBe(true);
    }
  });

  it('never offers a time inside min_booking_hours', async () => {
    seed({ policy: { min_booking_hours: 48 } });
    const { body } = await getSlots();
    expect(body.slots.length).toBeGreaterThan(0);
    const floor = new Date(Date.now() + 48 * 3600 * 1000);
    for (const s of body.slots) {
      expect(new Date(`${s}Z`) >= floor, `${s} is inside the 48 hour notice period`).toBe(true);
    }
  });

  it('sizes the slot by the real total: duration plus buffer plus padding', async () => {
    const day = openDay(6);
    seed({ apptDay: day, apptTime: '13:00', durationMinutes: 60 });
    // 60 + 20 buffer + 10 padding = 90 minutes. A 60-minute gap is not enough.
    const moving = db.appointments.find(a => a.id === APPT_ID);
    moving.buffer_minutes = 20;
    moving.extra_padding_minutes = 10;
    otherBooking(day, '09:00', '12:00');
    otherBooking(day, '13:00', '17:00');   // leaves exactly 12:00-13:00 free

    const { body } = await getSlots();
    expect(body.durationMinutes).toBe(90);
    expect(body.slots.filter(s => s.slice(0, 10) === day),
      'a 90-minute appointment was offered a 60-minute gap').toEqual([]);
  });

  it('an unreadable closure list is a 500, never a page full of free time', async () => {
    // loadBlocks throws when hours_exceptions cannot be read, and the route's
    // catch turns that into a 500. That is the right way round: read as empty,
    // it offers the client the middle of Ellie's holiday.
    seed();
    failing.set('hours_exceptions', { code: '500', message: 'boom' });
    const out = await getSlots();
    expect(out.status).toBe(500);
    expect(out.body.slots).toBeUndefined();
  });
});

/* ========================= 5. the two public availability readers =========== */

describe('a closure is a range in the public availability readers too', () => {
  // Ellie blocks out a week. One row: date = the first day, end_date = the last.
  const HOLIDAY_FROM = '2026-08-24';
  const HOLIDAY_TO = '2026-08-30';
  const holiday = (over = {}) => db.hours_exceptions.push({
    id: 'he1', beautician_id: 'b1', date: HOLIDAY_FROM, end_date: HOLIDAY_TO,
    type: 'closed', is_closed: true, start_time: null, end_time: null, reason: 'holiday', ...over,
  });

  beforeEach(() => { seed(); });

  it('GET /availability closes every day of the holiday, not just the first', async () => {
    holiday();
    for (const date of ['2026-08-24', '2026-08-25', '2026-08-27', '2026-08-30']) {
      const out = await run('get', '/:slug/availability', {
        params: { slug: 'ellindigo' }, query: { date },
      });
      expect(out.status).toBe(200);
      expect(out.body.closed, `${date} was still shown as open`).toBe(true);
    }
  });

  it('GET /availability leaves the days either side of the holiday alone', async () => {
    holiday();
    for (const date of ['2026-08-23', '2026-08-31']) {
      const out = await run('get', '/:slug/availability', {
        params: { slug: 'ellindigo' }, query: { date },
      });
      expect(out.body.closed, `${date} was closed and should not have been`).toBe(false);
    }
  });

  it('GET /availability treats a blank end_date as a single day', async () => {
    holiday({ end_date: null });
    const first = await run('get', '/:slug/availability', { params: { slug: 'ellindigo' }, query: { date: HOLIDAY_FROM } });
    const next = await run('get', '/:slug/availability', { params: { slug: 'ellindigo' }, query: { date: '2026-08-25' } });
    expect(first.body.closed).toBe(true);
    expect(next.body.closed).toBe(false);
  });

  it('GET /availability-range returns every closed day of the holiday', async () => {
    holiday();
    const out = await run('get', '/:slug/availability-range', {
      params: { slug: 'ellindigo' }, query: { from: '2026-08-01', to: '2026-08-31' },
    });
    expect(out.status).toBe(200);
    expect(out.body.closures.sort()).toEqual([
      '2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27',
      '2026-08-28', '2026-08-29', '2026-08-30',
    ]);
  });

  it('GET /availability-range clamps a closure to the window it was asked about', async () => {
    holiday();
    const out = await run('get', '/:slug/availability-range', {
      params: { slug: 'ellindigo' }, query: { from: '2026-08-26', to: '2026-08-28' },
    });
    expect(out.body.closures.sort()).toEqual(['2026-08-26', '2026-08-27', '2026-08-28']);
  });

  it('GET /availability-range finds a closure that STARTED before the window', async () => {
    // A fortnight off that began last Tuesday still closes today. Filtering on
    // date >= from alone never fetches the row at all.
    holiday();
    const out = await run('get', '/:slug/availability-range', {
      params: { slug: 'ellindigo' }, query: { from: '2026-08-28', to: '2026-09-05' },
    });
    expect(out.body.closures.sort()).toEqual(['2026-08-28', '2026-08-29', '2026-08-30']);
  });

  it('GET /availability finds a closure that STARTED before the day asked about', async () => {
    holiday();
    const out = await run('get', '/:slug/availability', {
      params: { slug: 'ellindigo' }, query: { date: '2026-08-29' },
    });
    expect(out.body.closed).toBe(true);
  });

  it('spreads a timed block across every day of its range, once per day', async () => {
    holiday({ type: 'amended', is_closed: false, start_time: '12:00', end_time: '14:00' });
    const out = await run('get', '/:slug/availability-range', {
      params: { slug: 'ellindigo' }, query: { from: '2026-08-01', to: '2026-08-31' },
    });
    expect(out.body.closures).toEqual([]);
    expect(out.body.blocks.map(b => b.date).sort()).toEqual([
      '2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27',
      '2026-08-28', '2026-08-29', '2026-08-30',
    ]);
    expect(out.body.blocks.every(b => b.start_time === '12:00' && b.end_time === '14:00')).toBe(true);
  });

  it('an unreadable exception list is an error, not an open diary', async () => {
    holiday();
    failing.set('hours_exceptions', { code: '500', message: 'boom' });
    const day = await run('get', '/:slug/availability', { params: { slug: 'ellindigo' }, query: { date: HOLIDAY_FROM } });
    const range = await run('get', '/:slug/availability-range', {
      params: { slug: 'ellindigo' }, query: { from: '2026-08-01', to: '2026-08-31' },
    });
    expect(day.status).toBe(500);
    expect(range.status).toBe(500);
  });
});

/* ======================================= 6. the way out when nothing is free */

describe('the manage page can always reach the salon', () => {
  it('hands the client the salon number, so "nothing free" is not a dead end', async () => {
    seed();
    const out = await run('get', '/:slug/manage/:token', { params: { slug: 'ellindigo', token: TOKEN } });
    expect(out.status).toBe(200);
    expect(out.body.appointment.beautician.phone).toBe('07700 900123');
    // The login email stays private.
    expect(out.body.appointment.beautician.email).toBeUndefined();
  });
});
