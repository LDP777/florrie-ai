/**
 * A client adding a treatment to a booking they already have.
 *
 * WHY THIS ROUTE EXISTS. Lucy Walker, 21 August, 06:50: "Hi - so sorry I just
 * realised I need to add lash lift to this booking! Should have been lash lift
 * + brow lamination, tint." Ellie: "You should be able to add and adjust your
 * booking. Did you receive a link at all?" Lucy: "No I didn't :/"
 *
 * Ellie was half right. Lucy had no link — that is fixed in notifications.js —
 * and even with one, the manage page could only SWAP her brow lamination for a
 * lash lift, never have both. So this drives the real route over real HTTP,
 * because the interesting parts are the refusals: what happens when the extra
 * treatment does not fit before the next client, or past closing, or over one
 * of Ellie's blocks. Getting any of those wrong books somebody into time that
 * is not there.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import { createServer } from 'node:http';

/* ---------------------------------------------------------------- the db -- */
const db = { appointments: [], treatments: [], patch_tests: [], hours_exceptions: [] };
const writes = [];
const failing = new Map();

function makeBuilder(table) {
  const preds = [];
  let pending = null;
  const rows = () => (db[table] || []).filter(r => preds.every(p => p(r)));
  const settle = () => {
    if (failing.has(table)) return { data: null, error: failing.get(table) };
    if (pending) {
      const hit = rows();
      for (const r of hit) Object.assign(r, pending);
      writes.push({ table, patch: pending, ids: hit.map(r => r.id) });
      return { data: hit, error: null };
    }
    return { data: rows(), error: null };
  };
  const b = {
    select() { return b; },
    update(p) { pending = p; return b; },
    insert(p) { db[table].push(p); writes.push({ table, insert: p }); return b; },
    eq(c, v) { preds.push(r => r[c] === v); return b; },
    neq(c, v) { preds.push(r => r[c] !== v); return b; },
    in(c, vs) { preds.push(r => vs.includes(r[c])); return b; },
    lt(c, v) { preds.push(r => String(r[c]) < String(v)); return b; },
    gt(c, v) { preds.push(r => String(r[c]) > String(v)); return b; },
    gte(c, v) { preds.push(r => String(r[c]) >= String(v)); return b; },
    lte(c, v) { preds.push(r => String(r[c]) <= String(v)); return b; },
    order() { return b; },
    limit() { return b; },
    maybeSingle() { const s = settle(); return Promise.resolve({ data: s.data?.[0] || null, error: s.error }); },
    single() { const s = settle(); return Promise.resolve({ data: s.data?.[0] || null, error: s.error }); },
    then(res) { return Promise.resolve(settle()).then(res); },
  };
  return b;
}
const supabase = { from: (t) => makeBuilder(t) };

vi.mock('../../src/config.js', () => ({ supabase, supabaseAdmin: supabase }));
vi.mock('../../src/lib/logger.js', () => ({ default: { info() {}, warn() {}, error() {}, debug() {} } }));
vi.mock('@sentry/node', () => ({ captureMessage() {}, captureException() {}, setUser() {} }));

const pushes = [];
vi.mock('../../src/services/push-notifications.js', () => ({
  pushNewBooking: async () => {}, pushBookingConfirmed: async () => {},
  pushReschedule: async () => {}, pushPatchTestBooked: async () => {},
  pushClientCancelled: async () => {},
  pushTeamUpdate: async (id, kind, text) => { pushes.push({ id, kind, text }); },
}));
vi.mock('../../src/services/notifications.js', () => ({
  notifyBookingConfirmed: async () => ({ sent: true }),
}));

const { default: bookingRouter } = await import('../../src/routes/booking.js');

/* ------------------------------------------------------------- the server -- */
const app = express();
app.use(express.json());
app.use('/api/booking', bookingRouter);
const server = createServer(app);
await new Promise(r => server.listen(0, r));
const PORT = server.address().port;

const post = (path, body) => fetch(`http://127.0.0.1:${PORT}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

/* --------------------------------------------------------------- fixtures -- */
const BIZ = 'biz-1';
const SLUG = 'ellindigo';
const TOKEN = 'c2765cc8-16f6-4d96-96ea-20b9822d6a3d';
const LAMINATION = 't-lam';
const LASH_LIFT = 't-lash';

// Lucy's actual booking: Mon 5 October, 14:00, Brow Lamination & tint, £40.
// Ellie's day runs to 18:00, so there is room for a 60-minute lash lift.
function seed(over = {}) {
  db.appointments = [{
    id: 'appt-lucy',
    management_token: TOKEN,
    starts_at: '2026-10-05T14:00:00',
    ends_at: '2026-10-05T15:00:00',
    status: 'confirmed',
    client_id: 'lucy',
    treatment_id: LAMINATION,
    extra_treatment_ids: null,
    duration_minutes: 60,
    price_cents: 4000,
    deposit_cents: 1000,
    deposit_paid: true,
    buffer_minutes: 0,
    extra_padding_minutes: 0,
    clients: { first_name: 'Lucy' },
    treatments: { id: LAMINATION, name: 'Brow Lamination & tint', duration_minutes: 60, price_cents: 4000, requires_patch_test: false },
    beauticians: {
      id: BIZ, booking_slug: SLUG, timezone: 'Europe/London',
      // free-slots keys these 'mon'..'sun', not 'monday'.
      working_hours: { mon: { start: '09:00', end: '18:00' } },
    },
    ...over,
  }];
  db.treatments = [
    { id: LAMINATION, beautician_id: BIZ, name: 'Brow Lamination & tint', duration_minutes: 60, price_cents: 4000, is_active: true, requires_patch_test: false },
    { id: LASH_LIFT, beautician_id: BIZ, name: 'Korean lash lift', duration_minutes: 60, price_cents: 5000, is_active: true, requires_patch_test: false },
    { id: 't-tint', beautician_id: BIZ, name: 'Lash tint', duration_minutes: 15, price_cents: 1000, is_active: true, requires_patch_test: true },
    { id: 't-gone', beautician_id: BIZ, name: 'Retired thing', duration_minutes: 30, price_cents: 2000, is_active: false, requires_patch_test: false },
  ];
  db.patch_tests = [];
  db.hours_exceptions = [];
}

const add = (t = LASH_LIFT, tok = TOKEN) => post(`/api/booking/${SLUG}/manage/${tok}/add-treatment`, { treatment_id: t });

beforeEach(() => { seed(); writes.length = 0; pushes.length = 0; failing.clear(); });

/* ------------------------------------------------------------------ tests -- */
describe('the message that asked for this', () => {
  it('adds the lash lift to the brow lamination, keeping both', async () => {
    const res = await add();
    expect(res.status).toBe(200);
    expect(res.body.extra_treatment_ids).toEqual([LASH_LIFT]);
    // Both treatments, not one instead of the other. This is the whole point.
    expect(res.body.duration_minutes).toBe(120);
    expect(res.body.price_cents).toBe(9000);
    expect(res.body.ends_at).toBe('2026-10-05T16:00:00');
  });

  it('tells her what it now costs and when it now finishes, in her own words', async () => {
    const res = await add();
    expect(res.body.message).toContain('Korean lash lift added');
    expect(res.body.message).toContain('16:00');
    // £90 total, £10 deposit already paid.
    expect(res.body.message).toContain('£80.00 to pay on the day');
  });

  it('leaves the deposit exactly where it was', async () => {
    const res = await add();
    const patch = writes.find(w => w.table === 'appointments')?.patch || {};
    expect(patch).not.toHaveProperty('deposit_cents');
    expect(patch).not.toHaveProperty('deposit_paid');
    expect(res.body.depositPaidCents).toBe(1000);
    expect(res.body.remainingCents).toBe(8000);
  });

  it('tells Ellie, because her diary just got longer without her', async () => {
    await add();
    expect(pushes).toHaveLength(1);
    expect(pushes[0].text).toContain('Lucy added Korean lash lift');
    expect(pushes[0].text).toContain('finishes at 16:00');
  });

  it('stacks a second addition on top of the first', async () => {
    await add();
    db.appointments[0].extra_treatment_ids = [LASH_LIFT];
    db.appointments[0].duration_minutes = 120;
    db.appointments[0].price_cents = 9000;
    db.patch_tests = [{ client_id: 'lucy', beautician_id: BIZ, status: 'passed', test_date: '2026-08-01' }];
    const res = await add('t-tint');
    expect(res.status).toBe(200);
    expect(res.body.extra_treatment_ids).toEqual([LASH_LIFT, 't-tint']);
    expect(res.body.duration_minutes).toBe(135);
    expect(res.body.price_cents).toBe(10000);
  });
});

describe('it will not book time that is not there', () => {
  it('refuses when the next client is in the way', async () => {
    db.appointments.push({
      id: 'appt-next', beautician_id: BIZ, status: 'confirmed',
      starts_at: '2026-10-05T15:00:00.000Z', ends_at: '2026-10-05T16:00:00.000Z',
    });
    const res = await add();
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/not enough time after your appointment/i);
    // And it points at the one person who can fix it.
    expect(res.body.error).toMatch(/message me/i);
    expect(writes.filter(w => w.patch)).toHaveLength(0);
  });

  it('refuses when it would run past closing time', async () => {
    db.appointments[0].starts_at = '2026-10-05T17:00:00';
    db.appointments[0].ends_at = '2026-10-05T18:00:00';
    const res = await add();
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/past closing time/i);
    expect(writes.filter(w => w.patch)).toHaveLength(0);
  });

  it('refuses when it would run into one of her blocks', async () => {
    // Exactly what Ellie ended up doing by hand: a 30-minute block out.
    db.hours_exceptions = [{ beautician_id: BIZ, date: '2026-10-05', type: 'break', start_time: '15:00', end_time: '15:30' }];
    const res = await add();
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/not enough time left in that slot/i);
    expect(writes.filter(w => w.patch)).toHaveLength(0);
  });

  it('changes nothing when the clash check itself fails', async () => {
    // Unchecked, this is how a booking lands on top of the next client.
    let calls = 0;
    const realFrom = supabase.from;
    supabase.from = (t) => {
      // Call one is the appointment lookup; call two is the clash check.
      if (t === 'appointments' && ++calls === 2) {
        const bad = {};
        for (const m of ['select', 'eq', 'neq', 'in', 'lt', 'gt', 'gte', 'lte', 'order', 'limit']) bad[m] = () => bad;
        bad.then = (r) => Promise.resolve({ data: null, error: { message: 'boom' } }).then(r);
        return bad;
      }
      return realFrom(t);
    };
    const res = await add();
    supabase.from = realFrom;
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/nothing has been changed/i);
  });
});

describe('what a client may not do', () => {
  it('refuses a token that does not match the salon in the url', async () => {
    const res = await post(`/api/booking/someone-else/manage/${TOKEN}/add-treatment`, { treatment_id: LASH_LIFT });
    expect(res.status).toBe(401);
  });

  it('refuses an unknown token', async () => {
    const res = await add(LASH_LIFT, 'not-a-real-token');
    expect(res.status).toBe(401);
  });

  it('refuses to touch a cancelled booking', async () => {
    db.appointments[0].status = 'cancelled';
    const res = await add();
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no longer be changed/i);
  });

  it('refuses an appointment that has already happened', async () => {
    db.appointments[0].starts_at = '2020-01-01T10:00:00';
    const res = await add();
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already passed/i);
  });

  it('refuses a treatment that belongs to another salon', async () => {
    db.treatments.push({ id: 't-other', beautician_id: 'biz-2', name: 'Someone elses', duration_minutes: 30, price_cents: 3000, is_active: true });
    const res = await add('t-other');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not available/i);
  });

  it('refuses a treatment she has retired', async () => {
    const res = await add('t-gone');
    expect(res.status).toBe(400);
  });

  it('asks for a treatment when none was sent', async () => {
    const res = await post(`/api/booking/${SLUG}/manage/${TOKEN}/add-treatment`, {});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/choose a treatment/i);
  });
});

describe('a patch test is still a patch test', () => {
  it('refuses a treatment needing one they have not had', async () => {
    const res = await add('t-tint');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/patch test first/i);
  });

  it('allows it when a valid test is on file', async () => {
    db.patch_tests = [{ client_id: 'lucy', beautician_id: BIZ, status: 'passed', test_date: '2026-08-01' }];
    const res = await add('t-tint');
    expect(res.status).toBe(200);
  });

  it('does not count an expired test', async () => {
    db.patch_tests = [{ client_id: 'lucy', beautician_id: BIZ, status: 'passed', test_date: '2020-01-01' }];
    const res = await add('t-tint');
    expect(res.status).toBe(409);
  });

  it('lets it through when they are already booked into a patch-test treatment', async () => {
    db.appointments[0].treatments.requires_patch_test = true;
    const res = await add('t-tint');
    expect(res.status).toBe(200);
  });
});

describe('a slow connection must not book it twice', () => {
  it('refuses a treatment already on the booking', async () => {
    db.appointments[0].extra_treatment_ids = [LASH_LIFT];
    const res = await add();
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already on this booking/i);
  });

  it('refuses adding the base treatment again', async () => {
    const res = await add(LAMINATION);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already on this booking/i);
  });

  it('caps how many one appointment can hold', async () => {
    db.appointments[0].extra_treatment_ids = Array.from({ length: 10 }, (_, i) => `x-${i}`);
    const res = await add();
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/as many treatments as one appointment can hold/i);
  });
});

describe('adding only, on purpose', () => {
  it('has no way to take a treatment off', async () => {
    // Removing drops the price below what may already be paid and frees diary
    // time Ellie may have filled around. That stays with her, in the app.
    const res = await fetch(`http://127.0.0.1:${PORT}/api/booking/${SLUG}/manage/${TOKEN}/remove-treatment`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    expect(res.status).toBe(404);
  });
});
