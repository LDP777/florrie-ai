/**
 * A cancellation leaves a gap and the waitlist stays silent.
 *
 * fetchWaitlistPool selected `waitlist.preferred_times`. The column on
 * `waitlist` is preferred_time, SINGULAR and scalar, added by
 * supabase/migrations/070_waitlist_pro_columns.sql with a default of 'any'.
 * `preferred_times` plural is a real column, but on client_intelligence, a
 * different table entirely. PostgREST rejected the whole select, the pool came
 * back empty, and the waitlist branch of the gap-fill engine has never matched
 * anybody. Somebody cancels, the slot goes begging, and the woman who asked to
 * be told hears nothing.
 *
 * Underneath that was a second mismatch that would have kept it broken even
 * after the rename. `preferred_days` holds the short keys the WaitlistPro chips
 * write ('mon', 'tue'), the same keys working_hours uses everywhere else in
 * this codebase. matchesPreferences compared them against full names
 * ('monday'), so any waiter who had expressed a day preference at all matched
 * nothing. Only a waiter with no preferences whatsoever could ever have been
 * offered a slot.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const PHANTOM = { waitlist: ['preferred_times'] };

const db = { beauticians: [], appointments: [], waitlist: [], clients: [], ai_actions: [] };
const rejected = [];

function leafColumns(cols) {
  return String(cols).replace(/[()]/g, ',').split(',').map(s => s.trim()).filter(Boolean);
}

function builder(table) {
  const filters = [];
  let bad = null;
  let head = false;
  const rows = () => (db[table] || []).filter(r => filters.every(f => f(r)));
  const settle = () => {
    if (bad) return { data: null, error: { code: '42703', message: `column ${table}.${bad} does not exist` }, count: null };
    if (head) return { data: null, error: null, count: rows().length };
    return { data: rows(), error: null };
  };
  const b = {
    select(cols, opts) {
      if (opts?.head) head = true;
      bad = leafColumns(cols).find(c => (PHANTOM[table] || []).includes(c)) || null;
      if (bad) rejected.push({ table, column: bad });
      return b;
    },
    insert() { return b; }, update() { return b; },
    eq(c, v) { filters.push(r => r[c] === v); return b; },
    neq(c, v) { filters.push(r => r[c] !== v); return b; },
    in(c, v) { filters.push(r => v.includes(r[c])); return b; },
    is(c, v) { filters.push(r => (r[c] ?? null) === v); return b; },
    not(c, _op, v) { filters.push(r => (r[c] ?? null) !== v); return b; },
    gte(c, v) { filters.push(r => String(r[c] ?? '') >= String(v)); return b; },
    lte(c, v) { filters.push(r => String(r[c] ?? '') <= String(v)); return b; },
    gt() { return b; }, lt() { return b; }, or() { return b; },
    like() { return b; }, ilike() { return b; }, contains() { return b; },
    order() { return b; }, limit() { return b; },
    maybeSingle() { const o = settle(); return Promise.resolve(o.error ? o : { data: (o.data || [])[0] || null, error: null }); },
    single() { const o = settle(); return Promise.resolve(o.error ? o : { data: (o.data || [])[0] || null, error: null }); },
    then(res, rej) { return Promise.resolve(settle()).then(res, rej); },
  };
  return b;
}

vi.mock('../../src/config.js', () => ({ supabase: { from: builder } }));

const offers = [];
vi.mock('../../src/services/notifications.js', () => ({
  sendNudge: async (args) => { offers.push(args); return { channel: 'sms' }; },
}));
vi.mock('../../src/lib/outbound-guard.js', () => ({
  guardedSend: async ({ send }) => ({ decision: 'send', tier: 'proactive', reason: 'trusted_auto', delivered: !!(await send()) }),
  recordOutbound: async () => 'rec1',
}));
vi.mock('../../src/services/sms-metering.js', () => ({ shouldAutoSend: async () => ({ shouldSend: true }) }));
vi.mock('../../src/services/loyalty.js', () => ({
  getLoyaltyConfig: async () => null, getClientPoints: async () => 0, loyaltyProximity: () => null,
}));
vi.mock('../../src/lib/promos.js', () => ({ getActivePromos: async () => [], describePromo: () => '' }));
vi.mock('../../src/lib/future-bookings.js', () => ({ getFutureBookedClientIds: async () => new Set() }));
vi.mock('../../src/services/live-activity.js', () => ({ refreshLiveActivity: async () => true }));
vi.mock('../../src/lib/ai-actions.js', () => ({ normaliseOutcome: (s) => (s === 'executed' ? 'success' : 'pending') }));

const { checkGapFillOpportunities } = await import('../../src/services/gap-fill-engine.js');

// A wide-open week so there is a gap on every day, and the day/time preference
// is the only thing that can decide the match.
const OPEN = { start: '09:00', end: '18:00' };
const workingHours = { mon: OPEN, tue: OPEN, wed: OPEN, thu: OPEN, fri: OPEN, sat: OPEN, sun: OPEN };

const waiter = (over = {}) => ({
  id: 'w1', beautician_id: 'b1', client_id: 'c1', status: 'waiting', notified_at: null,
  preferred_days: [], preferred_time: 'any',
  treatments: { name: 'brow lamination', duration_minutes: 45 },
  clients: { id: 'c1', first_name: 'Shauna', last_name: 'Reid', phone: '+447700900007', email: 'shauna@example.com' },
  ...over,
});

beforeEach(() => {
  for (const t of Object.keys(db)) db[t] = [];
  offers.length = 0;
  rejected.length = 0;
  db.beauticians.push({
    id: 'b1', working_hours: workingHours, whatsapp_phone_id: null,
    client_reminder_prefs: {}, timezone: 'Europe/London', booking_slug: 'ellindigo', autonomy: {},
  });
});

describe('the woman who asked to be told', () => {
  it('is offered the slot', async () => {
    db.waitlist.push(waiter());

    const result = await checkGapFillOpportunities('b1', 0.9);

    expect(result.matched).toBeGreaterThan(0);
    expect(offers.length).toBeGreaterThan(0);
    expect(offers[0].body).toContain('Shauna');
    expect(offers[0].body).toMatch(/just opened up/i);
  });

  it('and the select that finds her is not rejected for a column that is not there', async () => {
    db.waitlist.push(waiter());
    await checkGapFillOpportunities('b1', 0.9);
    expect(rejected).toEqual([]);
  });
});

describe('the preferences she actually set', () => {
  it('a morning-only waiter is offered a morning slot', async () => {
    db.waitlist.push(waiter({ preferred_time: 'morning' }));
    const result = await checkGapFillOpportunities('b1', 0.9);
    expect(result.matched).toBeGreaterThan(0);
    const [hh] = offers[0].body.match(/at (\d\d):\d\d/)?.slice(1) || [];
    expect(Number(hh)).toBeLessThan(12);
  });

  it('an evening-only waiter is not offered a nine-in-the-morning slot', async () => {
    // The week is open 09:00 to 18:00, so the only gaps start in the morning
    // and early afternoon. Nothing here is an evening.
    db.waitlist.push(waiter({ preferred_time: 'evening' }));
    const result = await checkGapFillOpportunities('b1', 0.9);
    expect(result.matched).toBe(0);
    expect(offers).toHaveLength(0);
  });

  it("'any' means any, which is what the column defaults to", async () => {
    db.waitlist.push(waiter({ preferred_time: 'any' }));
    const result = await checkGapFillOpportunities('b1', 0.9);
    expect(result.matched).toBeGreaterThan(0);
  });

  it('a waiter who picked days is matched on the SHORT keys the chips write', async () => {
    // 'mon'..'sun', the same keys working_hours uses. Every day is open here,
    // so a waiter listing all seven short keys must match something. Comparing
    // these against 'monday' matched nothing, which is what used to happen.
    db.waitlist.push(waiter({ preferred_days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] }));
    const result = await checkGapFillOpportunities('b1', 0.9);
    expect(result.matched).toBeGreaterThan(0);
  });

  it('and full day names are still understood, so nothing already stored breaks', async () => {
    db.waitlist.push(waiter({ preferred_days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] }));
    const result = await checkGapFillOpportunities('b1', 0.9);
    expect(result.matched).toBeGreaterThan(0);
  });

  it('a day she did not pick is still a day she did not pick', async () => {
    const dayKeys = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    // Every day in the next week except today and the six that follow it is
    // nothing at all, so pick a single day and assert we only ever offer that.
    const chosen = dayKeys[(new Date().getDay() + 3) % 7];
    db.waitlist.push(waiter({ preferred_days: [chosen] }));

    const result = await checkGapFillOpportunities('b1', 0.9);

    expect(result.matched).toBeGreaterThan(0);
    const labels = offers.map(o => o.body.match(/on (\w{3})/)?.[1]?.toLowerCase());
    for (const l of labels) expect(l).toBe(chosen);
  });
});

describe('a treatment that does not fit', () => {
  it('is not offered a gap it cannot fit into', async () => {
    // Only one appointment-free stretch exists per day and it is nine hours,
    // so make the treatment longer than the whole working day.
    db.waitlist.push(waiter({ treatments: { name: 'full day of lashes', duration_minutes: 600 } }));
    const result = await checkGapFillOpportunities('b1', 0.9);
    expect(result.matched).toBe(0);
  });
});
