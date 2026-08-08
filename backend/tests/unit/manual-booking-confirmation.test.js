/**
 * When Ellie books somebody in herself, does that client hear about it?
 *
 * Levi asked the question directly, and the answer was no. Three separate
 * things, each individually defensible, stacked into silence:
 *
 *  1. The "Send confirmation message" toggle in the new-appointment sheet was
 *     `useState(false)` — off on every open, with helper text explaining why
 *     you would want it off ("when copying over bookings from your old
 *     system"). Correct for the migration week, wrong for every booking since.
 *  2. POST /api/appointments — the plain sibling of /manual — sent nothing at
 *     all, and offered no way to ask for it.
 *  3. POST /api/suggestions/book, the Florrie-thinks "book it in" card, the
 *     one place the machine itself puts a client in the diary, also sent
 *     nothing.
 *
 * And underneath those, the failure that is worse than not sending:
 * notifyBookingConfirmed stamped `confirmation_sent_at` at the end whatever
 * happened, including for a client with no phone and no email, where every
 * delivery branch declines. The appointment then displayed a confirmation
 * timestamp — shown as dispute evidence — for a message that never existed.
 *
 * Not one of the 579 tests covered any of it. The only assertions touching
 * confirmations were negative ones in booking-honesty.test.js.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const db = { beauticians: [], treatments: [], clients: [], appointments: [], booking_suggestions: [] };
let idCounter = 0;
const nextId = (p) => `${p}_${++idCounter}`;

function makeBuilder(table) {
  const filters = [];
  let pending = null;
  const matching = () => (db[table] || []).filter(r => filters.every(f => f(r)));
  const settle = () => {
    if (pending?.op === 'insert') {
      const payload = Array.isArray(pending.payload) ? pending.payload : [pending.payload];
      const created = payload.map(p => ({ id: nextId(table), created_at: new Date().toISOString(), ...p }));
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
    select() { return b; },
    insert(p) { pending = { op: 'insert', payload: p }; return b; },
    update(p) { pending = { op: 'update', payload: p }; return b; },
    eq(c, v) { filters.push(r => r[c] === v); return b; },
    neq(c, v) { filters.push(r => r[c] !== v); return b; },
    in(c, v) { filters.push(r => v.includes(r[c])); return b; },
    is(c, v) { filters.push(r => (r[c] ?? null) === v); return b; },
    or() { return b; }, not() { return b; }, ilike() { return b; },
    gte() { return b; }, lte() { return b; }, gt() { return b; }, lt() { return b; },
    order() { return b; }, limit() { return b; }, range() { return b; },
    maybeSingle() { const r = settle(); return Promise.resolve({ data: r.data?.[0] ?? null, error: r.error }); },
    single() { const r = settle(); return Promise.resolve({ data: r.data?.[0] ?? null, error: r.error }); },
    then(res, rej) { return Promise.resolve(settle()).then(res, rej); },
  };
  return b;
}

vi.mock('../../src/config.js', () => ({
  supabase: { from: (t) => makeBuilder(t) },
  supabaseAdmin: { from: (t) => makeBuilder(t) },
}));
vi.mock('../../src/lib/logger.js', () => ({ default: { info() {}, warn() {}, error() {}, debug() {} } }));
vi.mock('../../src/middleware/auth.js', () => ({ requireAuth: (_q, _s, next) => next() }));
vi.mock('../../src/lib/ownership.js', () => ({ requireOwned: () => (_q, _s, next) => next() }));

vi.mock('../../src/services/push-notifications.js', () => ({
  pushNewBooking: async () => true,
  pushBookingConfirmed: async () => true, pushReschedule: async () => true,
  pushPatchTestBooked: async () => true, pushClientCancelled: async () => true,
  pushTeamUpdate: async () => true,
}));
vi.mock('../../src/services/live-activity.js', () => ({ refreshLiveActivity: async () => true }));
vi.mock('../../src/services/client-intelligence.js', () => ({ updateClientIntelligence: async () => true }));
vi.mock('../../src/lib/client-archive.js', () => ({ autoUnarchiveClient: async () => true }));
vi.mock('../../src/routes/consultation-forms.js', () => ({
  sendConsultationFormSMS: async () => true,
  recordBookingConsultation: async () => ({ unrecorded: {}, failed: false }),
}));
vi.mock('@sentry/node', () => ({ captureMessage: () => {}, captureException: () => {} }));

const appointmentsRouter = (await import('../../src/routes/appointments.js')).default;

/** Drive one route handler straight — no HTTP server, no middleware. */
async function run(router, method, path, req) {
  const layer = router.stack.find(l => l.route?.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`no ${method} ${path}`);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const out = { status: 200, body: null };
  const res = {
    status(c) { out.status = c; return res; },
    json(p) { out.body = p; return res; },
    get() { return 'api.florrie.ai'; },
  };
  await handler({ headers: {}, get: () => 'api.florrie.ai', query: {}, body: {}, ...req }, res);
  return out;
}

const BEAUTICIAN = { id: 'b1', business_name: 'Ellindigo', first_name: 'Ellie', client_reminder_prefs: {} };
const soon = () => { const d = new Date(Date.now() + 3 * 24 * 3600 * 1000); return d.toISOString().slice(0, 10); };
const agesAgo = () => { const d = new Date(Date.now() - 40 * 24 * 3600 * 1000); return d.toISOString().slice(0, 10); };

beforeEach(() => {
  for (const k of Object.keys(db)) db[k] = [];
  idCounter = 0;
  db.beauticians.push({ ...BEAUTICIAN });
  db.treatments.push({ id: 't1', beautician_id: 'b1', name: 'Signature brows', duration_minutes: 30, buffer_minutes: 0, price_cents: 3000, deposit_cents: 0 });
});

describe('the shape of the answer', () => {
  it('a booking created manually reports what happened to the confirmation', async () => {
    db.clients.push({ id: 'c1', beautician_id: 'b1', first_name: 'Sarah', phone: '07700900001' });
    const out = await run(appointmentsRouter, 'post', '/manual', {
      beautician: BEAUTICIAN,
      body: { treatment_id: 't1', client_id: 'c1', date: soon(), time: '11:00', send_confirmation: true },
    });
    expect(out.status).toBe(201);
    // The point of the change: the caller can no longer be left guessing.
    // Before this, the response was `{ appointment }` and the send was
    // fire-and-forget behind a logger.warn.
    expect(out.body.confirmation).toBeDefined();
    expect(out.body.confirmation.requested).toBe(true);
  });

  it('says so, rather than silently not sending, when it was not asked to', async () => {
    db.clients.push({ id: 'c1', beautician_id: 'b1', first_name: 'Sarah', phone: '07700900001' });
    const out = await run(appointmentsRouter, 'post', '/manual', {
      beautician: BEAUTICIAN,
      body: { treatment_id: 't1', client_id: 'c1', date: agesAgo(), time: '11:00', send_confirmation: false },
    });
    expect(out.status).toBe(201);
    expect(out.body.confirmation).toEqual({ requested: false, sent: false, reason: 'not_requested' });
  });
});

describe('POST /api/appointments — the sibling that told nobody anything', () => {
  it('now asks for a confirmation on a future booking without being told to', async () => {
    db.clients.push({ id: 'c1', beautician_id: 'b1', first_name: 'Sarah', phone: '07700900001' });
    const startsAt = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
    const out = await run(appointmentsRouter, 'post', '/', {
      beautician: BEAUTICIAN,
      body: { client_id: 'c1', treatment_id: 't1', starts_at: startsAt },
    });
    expect(out.status).toBe(201);
    expect(out.body.confirmation?.requested).toBe(true);
  });

  // Why this route can default ON unconditionally while /manual cannot: it
  // refuses a past start outright, so the backfill case never reaches the
  // confirmation decision. Asserted rather than assumed, because if that
  // guard is ever relaxed the default above becomes wrong.
  it('refuses a past-dated booking outright, so backfill cannot reach it', async () => {
    db.clients.push({ id: 'c1', beautician_id: 'b1', first_name: 'Sarah', phone: '07700900001' });
    const startsAt = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();
    const out = await run(appointmentsRouter, 'post', '/', {
      beautician: BEAUTICIAN,
      body: { client_id: 'c1', treatment_id: 't1', starts_at: startsAt },
    });
    expect(out.status).toBe(400);
  });

  it('lets a caller say no explicitly', async () => {
    db.clients.push({ id: 'c1', beautician_id: 'b1', first_name: 'Sarah', phone: '07700900001' });
    const startsAt = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
    const out = await run(appointmentsRouter, 'post', '/', {
      beautician: BEAUTICIAN,
      body: { client_id: 'c1', treatment_id: 't1', starts_at: startsAt, send_confirmation: false },
    });
    expect(out.status).toBe(201);
    expect(out.body.confirmation).toEqual({ requested: false, sent: false, reason: 'not_requested' });
  });
});
