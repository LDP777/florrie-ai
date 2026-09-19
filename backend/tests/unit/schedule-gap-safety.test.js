import { beforeEach, afterEach, afterAll, describe, it, expect, vi } from 'vitest';
import express from 'express';
import { createServer } from 'node:http';

const state = vi.hoisted(() => ({ db: {}, fail: null, afterMatchRead: null, duringGuard: null, approve: false, guards: [], deliveries: [], capTable: null, missingCount: null }));
vi.mock('../../src/config.js', () => ({ supabase: { from(table) {
  const filters = [];
  let select = '';
  let exactCount = false;
  const b = {
    select(value, options) { select = value; exactCount = options?.count === 'exact'; return b; },
    eq(c, v) { filters.push(r => r[c] === v); return b; },
    neq(c, v) { filters.push(r => r[c] !== v); return b; },
    in(c, values) { filters.push(r => values.includes(r[c])); return b; },
    is(c, v) { filters.push(r => (r[c] ?? null) === v); return b; },
    not(c, op, value) { filters.push(r => op === 'in' ? !value.slice(1, -1).split(',').includes(r[c]) : (r[c] ?? null) !== value); return b; },
    gte(c, v) { filters.push(r => r[c] >= v); return b; },
    lte(c, v) { filters.push(r => r[c] <= v); return b; },
    gt(c, v) { filters.push(r => r[c] > v); return b; },
    lt(c, v) { filters.push(r => r[c] < v); return b; },
    or() { return b; }, like() { return b; }, order() { return b; }, limit() { return b; },
    insert() { return b; }, update() { return b; },
    single() { return execute(true); }, maybeSingle() { return execute(true); },
    then(resolve, reject) { return execute(false).then(resolve, reject); },
  };
  async function execute(one) {
    if (state.fail === table) return { data: null, error: { code: 'XX000', message: 'Synthetic diary failure' } };
    const rows = (state.db[table] || []).filter(row => filters.every(f => f(row)));
    // This client lookup happens after matching, immediately before dispatch.
    if (table === 'clients' && select.includes('whatsapp_id') && state.afterMatchRead) {
      const hook = state.afterMatchRead; state.afterMatchRead = null; hook();
    }
    const returned = state.capTable === table ? rows.slice(0, 1000) : rows;
    return { data: one ? returned[0] || null : returned, error: null,
      count: exactCount && state.missingCount !== table ? rows.length : null };
  }
  return b;
} } }));
vi.mock('../../src/middleware/auth.js', () => ({ requireAuth: (req, res, next) => {
  if (req.headers.authorization !== 'Bearer fictional-owner') return res.status(401).json({ error: 'Unauthorized' });
  req.beautician = { id: 'owner', booking_slug: 'fictional-salon' }; next();
} }));
vi.mock('../../src/lib/logger.js', () => ({ default: { debug() {}, info() {}, warn() {}, error() {} } }));
vi.mock('../../src/services/florrie-thinking.js', () => ({ getFlorrieThoughts: async () => [] }));
vi.mock('../../src/services/florrie-heartbeat.js', () => ({ quietWeekStatus: async () => ({}) }));
vi.mock('../../src/lib/future-bookings.js', () => ({ getFutureBookedClientIds: async () => new Set() }));
vi.mock('../../src/services/loyalty.js', () => ({ getLoyaltyConfig: async () => null, getClientPoints: async () => 0, loyaltyProximity: () => null }));
vi.mock('../../src/lib/promos.js', () => ({ getActivePromos: async () => [], describePromo: () => '' }));
vi.mock('../../src/services/live-activity.js', () => ({ refreshLiveActivity: async () => true }));
vi.mock('../../src/services/sms-metering.js', () => ({ shouldAutoSend: async () => ({ shouldSend: true }) }));
vi.mock('../../src/services/notifications.js', () => ({
  sendSMS: async () => true, notifyBookingConfirmed: async () => true,
  sendOnPreferredChannel: async args => { state.deliveries.push(args); return { ok: true }; },
  sendNudge: async args => { state.deliveries.push(args); return { channel: 'sms' }; },
}));
vi.mock('../../src/lib/outbound-guard.js', () => ({
  recordOutbound: async args => { state.guards.push(args); return 'fictional-outbound'; },
  guardedSend: async args => {
    state.guards.push(args);
    if (state.duringGuard) { const hook = state.duringGuard; state.duringGuard = null; hook(); }
    if (state.approve) return { decision: 'approve', delivered: false };
    // Match the real guard's fail-soft callback boundary.
    try { return { decision: 'send', delivered: !!(await args.send()) }; }
    catch { return { decision: 'send', delivered: false }; }
  },
}));

const { default: router } = await import('../../src/routes/suggestions.js');
const { checkGapFillOpportunities, getGapFillSuggestions } = await import('../../src/services/gap-fill-engine.js');
const { computeCalendarGaps, gapRequest } = await import('../../src/lib/gap-availability.js');
const app = express(); app.use(express.json()); app.use('/api/suggestions', router);
const server = createServer(app);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
afterAll(() => new Promise(resolve => server.close(resolve)));

const date = '2026-09-21'; // Monday
const request = async (body = {}, authorized = true) => {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/suggestions/fill-gap`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorized ? { Authorization: 'Bearer fictional-owner' } : {}) },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
};
const exact = { date, start_time: '13:00', end_time: '14:00' };
const closed = (overrides = {}) => ({ beautician_id: 'owner', date, type: 'closed', ...overrides });
const appointment = (start, end, overrides = {}) => ({ beautician_id: 'owner', starts_at: `${date}T${start}:00Z`,
  ends_at: `${date}T${end}:00Z`, duration_minutes: 15, status: 'confirmed', ...overrides });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-21T07:00:00Z'));
  state.fail = null; state.afterMatchRead = null; state.duringGuard = null; state.approve = false;
  state.capTable = null; state.missingCount = null;
  state.guards = []; state.deliveries = [];
  state.db = {
    beauticians: [{ id: 'owner', timezone: 'Europe/London', working_hours: { mon: { start: '09:00', end: '17:00' }, tue: { start: '09:00', end: '17:00' } }, booking_slug: 'fictional-salon' }],
    appointments: [appointment('10:00', '13:00'), appointment('14:00', '17:00')],
    hours_exceptions: [], ai_actions: [],
    clients: [{ id: 'client', beautician_id: 'owner', first_name: 'Fictional', phone: '+447700900001', preferred_channel: 'sms' }],
    waitlist: [{ id: 'waiter', beautician_id: 'owner', client_id: 'client', status: 'waiting', notified_at: null,
      preferred_days: [], preferred_time: 'any', treatments: { name: 'Fictional treatment', duration_minutes: 45, buffer_minutes: 0 },
      clients: { id: 'client', first_name: 'Fictional', phone: '+447700900001' } }],
  };
});
afterEach(() => vi.useRealTimers());

describe('Schedule offers precisely the selected free time', () => {
  it('uses the later selected gap, not the first gap or the first candidate assignment', async () => {
    const result = await request(exact);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ sent: 1, held: 0, gap: { date, start: '13:00', end: '14:00', duration_minutes: 60 } });
    expect(state.deliveries).toHaveLength(1); expect(state.deliveries[0].body).toContain('13:00');
    expect(state.guards[0]).toMatchObject({ beauticianId: 'owner', messageType: 'gap_fill_offer', clientId: 'client' });
  });
  it('keeps an exact subrange even when the surrounding gap has grown', async () => {
    state.db.appointments = [];
    expect((await request(exact)).body.gap).toMatchObject({ start: '13:00', end: '14:00', duration_minutes: 60 });
    expect(state.deliveries[0].body).toContain('13:00');
  });
  it('preserves an approval-required result without sending', async () => {
    state.approve = true;
    expect((await request(exact)).body).toMatchObject({ sent: 0, held: 1 });
    expect(state.deliveries).toEqual([]);
  });
  it('date-only legacy requests stay on the supplied date and never fall back to another', async () => {
    state.db.hours_exceptions = [closed()];
    expect((await request({ date })).body.sent).toBe(0);
    expect(state.guards).toEqual([]);
    expect((await request({ date: '2026-09-22' })).body.gap.date).toBe('2026-09-22');
  });
  it('legacy requests with no selection choose the earliest available gap', async () => {
    expect((await request()).body.gap).toMatchObject({ date, start: '09:00', end: '10:00' });
  });
  it.each([
    { date: '2026-02-30', start_time: '13:00', end_time: '14:00' },
    { date, start_time: '13:00' }, { date, end_time: '14:00' },
    { start_time: '13:00', end_time: '14:00' },
    { ...exact, start_time: '25:00' }, { ...exact, end_time: '12:00' }, { ...exact, end_time: '13:00' },
  ])('refuses malformed or incomplete selection %j before matching or sending', async body => {
    expect(await request(body)).toMatchObject({ status: 400, body: { code: 'invalid_gap' } });
    expect(state.guards).toEqual([]); expect(state.deliveries).toEqual([]);
  });
  it('uses the authenticated owner, ignoring a forged owner field', async () => {
    state.db.hours_exceptions = [closed()];
    expect((await request({ ...exact, beautician_id: 'other-owner' })).status).toBe(409);
    expect((await request(exact, false)).status).toBe(401);
    expect(state.deliveries).toEqual([]);
  });
});

describe('current diary boundaries are checked before draft or delivery', () => {
  it.each([
    closed(), closed({ date: '2026-09-18', end_date: '2026-09-23' }),
    closed({ type: 'amended', start_time: '13:15:00', end_time: '13:30:00' }),
    closed({ type: 'extended', start_time: '13:15:00', end_time: '13:30:00' }),
  ])('does not offer blocked hours %j', async block => {
    state.db.hours_exceptions = [block];
    expect(await request(exact)).toMatchObject({ status: 409, body: { code: 'gap_unavailable' } });
    expect(state.guards).toEqual([]); expect(state.deliveries).toEqual([]);
  });
  it('respects changed regular hours and an explicitly disabled day', async () => {
    state.db.beauticians[0].working_hours.mon.end = '13:30';
    expect((await request(exact)).status).toBe(409);
    state.db.beauticians[0].working_hours.mon = { start: '09:00', end: '17:00', enabled: false };
    expect((await request(exact)).status).toBe(409);
  });
  it.each(['beauticians', 'appointments', 'hours_exceptions'])('does not turn a failed %s lookup into free time', async table => {
    state.fail = table;
    expect(await request(exact)).toMatchObject({ status: 503, body: { code: 'availability_unavailable' } });
    expect(state.guards).toEqual([]); expect(state.deliveries).toEqual([]);
  });
  it.each(['appointments', 'hours_exceptions'])('refuses a capped %s page with an occupied slot beyond row 1000', async table => {
    state.capTable = table;
    state.db[table] = table === 'appointments'
      ? [...Array.from({ length: 1000 }, () => appointment('09:00', '10:00')), appointment('13:30', '14:00')]
      : [...Array.from({ length: 1000 }, () => closed({ type: 'amended', start_time: '09:00:00', end_time: '10:00:00' })), closed()];
    expect(await request(exact)).toMatchObject({ status: 503, body: { code: 'availability_unavailable' } });
    expect(state.guards).toEqual([]); expect(state.deliveries).toEqual([]);
  });
  it('accepts exactly 1000 appointments when the exact count proves the read is complete', async () => {
    state.capTable = 'appointments';
    state.db.appointments = Array.from({ length: 1000 }, () => appointment('09:00', '10:00'));
    expect((await request(exact)).body).toMatchObject({ sent: 1, gap: { start: '13:00', end: '14:00' } });
  });
  it.each(['appointments', 'hours_exceptions'])('fails closed when the %s exact count is unavailable', async table => {
    state.missingCount = table;
    expect(await request(exact)).toMatchObject({ status: 503, body: { code: 'availability_unavailable' } });
    expect(state.guards).toEqual([]); expect(state.deliveries).toEqual([]);
  });
  it.each([
    { ends_at: 'unreadable' }, { ends_at: `${date}T12:59:00Z` }, { ends_at: `${date}T13:00:00Z` },
    { ends_at: null, duration_minutes: null }, { ends_at: null, buffer_minutes: -10 },
  ])('refuses unreadable occupied time instead of reopening it: %j', async timing => {
    state.db.appointments.push(appointment('13:00', '14:00', timing));
    expect(await request(exact)).toMatchObject({ status: 503, body: { code: 'availability_unavailable' } });
    expect(state.guards).toEqual([]); expect(state.deliveries).toEqual([]);
  });
  it('rechecks after the candidate lookup, before queueing a draft', async () => {
    state.approve = true; state.afterMatchRead = () => state.db.hours_exceptions.push(closed());
    expect((await request(exact)).status).toBe(409);
    expect(state.guards).toEqual([]); expect(state.deliveries).toEqual([]);
  });
  it('rechecks inside the send callback if the diary changed while permissions were checked', async () => {
    state.duringGuard = () => state.db.appointments.push(appointment('13:30', '14:00'));
    expect(await request(exact)).toMatchObject({ status: 409, body: { code: 'gap_unavailable', sent: 0 } });
    expect(state.deliveries).toEqual([]);
  });
  it('will not fit a treatment plus cleanup buffer into a shorter gap', async () => {
    state.db.waitlist[0].treatments = { name: 'Long treatment', duration_minutes: 60, buffer_minutes: 5 };
    expect((await request(exact)).body).toMatchObject({ sent: 0, candidates: 0 });
    expect(state.guards).toEqual([]);
  });
  it('also keeps the autonomous matcher away from closures', async () => {
    state.db.hours_exceptions = [closed({ end_date: '2026-09-27' })];
    expect(await checkGapFillOpportunities('owner', 0.9)).toEqual({ matched: 0, sent: 0, queued: 0 });
    expect(await getGapFillSuggestions('owner')).toEqual([]);
    expect(state.deliveries).toEqual([]); expect(state.guards).toEqual([]);
  });
});

describe('wall-clock gap calculation', () => {
  const now = new Date('2026-09-21T07:00:00Z');
  const hours = { mon: { start: '09:00', end: '17:00' } };
  it('uses actual ends, merges overlaps and clamps bookings beyond closing', () => {
    const gaps = computeCalendarGaps(now, [appointment('09:00', '11:00'), appointment('10:00', '12:00'), appointment('16:00', '19:00')], hours, 'Europe/London');
    expect(gaps.map(g => [g.start, g.end])).toEqual([['12:00', '16:00']]);
  });
  it('sees an appointment already in progress at salon now and does not apply BST twice', () => {
    const gaps = computeCalendarGaps(new Date('2026-09-21T12:30:00Z'), [appointment('13:00', '14:00')], hours, 'Europe/London');
    expect(gaps.map(g => [g.start, g.end])).toEqual([['14:00', '17:00']]);
  });
  it('includes overnight bookings and legacy duration plus buffer when ends_at is missing', () => {
    const gaps = computeCalendarGaps(now, [appointment('09:00', '10:00', { starts_at: '2026-09-19T18:00:00Z' }),
      appointment('11:00', '11:30', { ends_at: null, duration_minutes: 45, buffer_minutes: 15 })], hours, 'Europe/London');
    expect(gaps.map(g => [g.start, g.end])).toEqual([['10:00', '11:00'], ['12:00', '17:00']]);
  });
  it.each([null, 'not-a-date', '2026-09-21T25:00:00Z', '2026-02-30T09:00:00Z'])('does not discard an unreadable occupied start: %s', starts_at => {
    expect(() => computeCalendarGaps(now, [appointment('09:00', '10:00', { starts_at })], hours, 'Europe/London'))
      .toThrow('Could not check the diary');
  });
  it('releases cancelled and no-show appointments but keeps pending bookings busy', () => {
    const gaps = computeCalendarGaps(now, [appointment('09:00', '10:00', { status: 'cancelled_by_client' }),
      appointment('10:00', '11:00', { status: 'no_show' }), appointment('11:00', '12:00', { status: 'pending' })], hours, 'Europe/London');
    expect(gaps.map(g => [g.start, g.end])).toEqual([['09:00', '11:00'], ['12:00', '17:00']]);
  });
  it('walks seven calendar days across the autumn clock change without duplicate days', () => {
    const everyDay = Object.fromEntries(['mon','tue','wed','thu','fri','sat','sun'].map(day => [day, { start: '09:00', end: '17:00' }]));
    const gaps = computeCalendarGaps(new Date('2026-10-24T07:00:00Z'), [], everyDay, 'Europe/London');
    expect(gaps).toHaveLength(7); expect(new Set(gaps.map(g => g.date)).size).toBe(7);
  });
  it('parses valid legacy and exact requests without allowing date normalization', () => {
    expect(gapRequest({ date })).toEqual({ date });
    expect(gapRequest(exact)).toEqual({ date, start: '13:00', end: '14:00' });
    expect(() => gapRequest({ date: `${date}garbage` })).toThrow();
  });
});
