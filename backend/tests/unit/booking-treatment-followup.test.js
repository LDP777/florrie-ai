import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ db: {}, writes: [], slots: [], slotReads: [], confirmations: [] }));
function builder(table) {
  let action; let payload; let fields; let head = false; let order; let limit = Infinity;
  const filters = [];
  const settle = () => {
    let rows = (fixture.db[table] || []).filter(row => filters.every(filter => filter(row)));
    if (action) fixture.writes.push({ table, action, payload });
    if (action === 'update') rows.forEach(row => Object.assign(row, payload));
    if (action === 'delete') fixture.db[table] = (fixture.db[table] || []).filter(row => !rows.includes(row));
    if (action === 'insert') {
      rows = (Array.isArray(payload) ? payload : [payload]).map((row, i) => ({ id: `${table}-${i}`, ...row }));
      (fixture.db[table] ||= []).push(...rows);
    }
    if (action === 'upsert') {
      let saved = (fixture.db[table] || []).find(row => row.beautician_id === payload.beautician_id && row.client_id === payload.client_id);
      if (saved) Object.assign(saved, payload);
      else { saved = { id: `${table}-state`, ...payload }; (fixture.db[table] ||= []).push(saved); }
      rows = [saved];
    }
    if (order) rows = [...rows].sort((a, b) => String(a[order.key]).localeCompare(String(b[order.key])) * (order.asc ? 1 : -1));
    rows = rows.slice(0, limit);
    if (fields && fields !== '*' && !fields.includes('(')) rows = rows.map(row => Object.fromEntries(fields.split(',').map(key => key.trim()).filter(key => key in row).map(key => [key, row[key]])));
    return { data: head ? null : rows, count: rows.length, error: null };
  };
  const q = {
    select(value, options) { fields = value; head = options?.head === true; return q; },
    insert(value) { action = 'insert'; payload = value; return q; },
    upsert(value) { action = 'upsert'; payload = value; return q; },
    update(value) { action = 'update'; payload = value; return q; },
    delete() { action = 'delete'; return q; },
    eq(key, value) { filters.push(row => row[key] === value); return q; },
    neq(key, value) { filters.push(row => row[key] !== value); return q; },
    in(key, values) { filters.push(row => values.includes(row[key])); return q; },
    gte() { return q; }, lte() { return q; }, gt() { return q; }, lt() { return q; },
    is() { return q; }, not() { return q; }, or() { return q; },
    order(key, options) { order = { key, asc: options?.ascending !== false }; return q; },
    limit(value) { limit = value; return q; },
    single() { const result = settle(); return Promise.resolve({ ...result, data: result.data?.[0] || null }); },
    maybeSingle() { return q.single(); },
    then(resolve, reject) { return Promise.resolve(settle()).then(resolve, reject); },
  };
  return q;
}
vi.mock('../../src/config.js', () => ({ supabase: { from: builder } }));
vi.mock('stripe', () => ({ default: class { constructor() { this.checkout = { sessions: { create: async () => { throw new Error('No payment session expected'); } } }; } } }));
vi.mock('../../src/lib/schema-probe.js', () => ({ hasColumn: async () => true }));
vi.mock('../../src/lib/free-slots.js', () => ({
  nowInSalonWall: () => new Date('2026-10-01T11:00:00Z'),
  getFreeSlots: async (owner, options) => {
    fixture.slotReads.push({ owner, ...options });
    const end = new Date(options.fromWall.getTime() + options.days * 86400000).toISOString().slice(0, 10);
    const start = options.fromWall.toISOString().slice(0, 10);
    return fixture.slots.filter(slot => slot.date >= start && slot.date < end);
  },
}));
vi.mock('../../src/services/notifications.js', () => ({ notifyBookingConfirmed: async id => { fixture.confirmations.push(id); return true; } }));
vi.mock('../../src/services/booking-confirmed-alert.js', () => ({ announceBookingConfirmed: async () => ({ announced: true }), claimConfirmed: async () => ({ won: false }), BOOKING_CONFIRMED_ACTION: 'booking_confirmed' }));
vi.mock('../../src/lib/logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { advanceBookingConversation } from '../../src/services/conversational-booking.js';
import { bookingPreferencesFrom, slotsWithinBookingPreferences } from '../../src/lib/booking-preferences.js';

const NOW = new Date('2026-10-01T10:00:00Z');
const owner = { id: 'fictional-salon', first_name: 'Mara', business_name: 'Fictional Salon', timezone: 'Europe/London', booking_slug: 'fictional', booking_policy: {}, payment_settings: {} };
const client = { id: 'fictional-client', beautician_id: owner.id, first_name: 'Client', blocked_at: null };
const treatments = [
  { id: 'brow', name: 'Brow Lamination', duration_minutes: 45, price_cents: 3500, requires_patch_test: false, requires_consultation: false },
  { id: 'tint', name: 'Brow Tint', duration_minutes: 20, price_cents: 2000, requires_patch_test: false, requires_consultation: false },
];
const slot = (date, time) => ({ date, time, iso: `${date}T${time}:00.000Z` });
const request = 'Do you have any availability this month after 4/4:30?';
const answer = 'A brow lamination if possible x';
const state = () => fixture.db.booking_conversations[0];
const advance = (message, intent = 'booking_request', extra = {}) => advanceBookingConversation({
  beautician: owner, client, message, classification: { intent, confidence: 0.99 },
  context: { treatments, clientUpcoming: [], conversation: [], ...extra },
});
const assertNoReservation = () => expect(fixture.writes.filter(write => write.table === 'appointments')).toEqual([]);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
  fixture.db = { clients: [{ ...client }], booking_conversations: [], appointments: [] };
  fixture.writes = []; fixture.slotReads = []; fixture.confirmations = [];
  owner.booking_policy = {};
  fixture.slots = [slot('2026-10-02', '09:00'), slot('2026-10-02', '16:00'), slot('2026-10-02', '16:30'), slot('2026-10-20', '17:00'), slot('2026-11-01', '17:00')];
});
afterEach(() => vi.useRealTimers());

describe('a treatment answer continues the client’s availability request', () => {
  it('saves the treatment question even when the opening classifier says availability_check', async () => {
    const result = await advance(request, 'availability_check');
    expect(result?.step).toBe('awaiting_treatment');
    expect(state()?.step).toBe('awaiting_treatment');
    expect(fixture.slotReads).toHaveLength(0);
    assertNoReservation();
  });

  it.each(['booking_request', 'availability_check'])('retains October and after-4:30 constraints after asking which treatment (%s)', async (intent) => {
    await advance(request, intent);
    const result = await advance(answer);
    expect(result?.step).toBe('awaiting_pick');
    expect(result.handOver).toBe(false);
    expect(state().offered.map(offer => [offer.date, offer.time])).toEqual([['2026-10-02', '16:30'], ['2026-10-20', '17:00']]);
    expect(fixture.slotReads.some(read => read.days > 14)).toBe(true);
    assertNoReservation();
  });

  it('uses the proven earlier request to recover an orphaned treatment question without holding a slot', async () => {
    const result = await advance(answer, 'booking_request', { bookingContinuation: { request, requestedAt: NOW.toISOString() } });
    expect(result?.step).toBe('awaiting_pick');
    expect(state().offered.map(offer => offer.time)).toEqual(['16:30', '17:00']);
    assertNoReservation();
  });

  it('does not start from an unproven or stale polite treatment mention', async () => {
    expect(await advance(answer)).toBeNull();
    expect(await advance(answer, 'booking_request', { bookingContinuation: { request, requestedAt: '2026-09-29T10:00:00Z' } })).toBeNull();
    expect(fixture.writes).toEqual([]);
  });

  it('anchors a recovered relative month to the actual request date', async () => {
    const result = await advance(answer, 'booking_request', { bookingContinuation: { request, requestedAt: '2026-09-30T22:00:00Z' } });
    expect(result?.handOver).toBe(true);
    expect(state()).toBeUndefined();
    assertNoReservation();
  });

  it('keeps a requested exact date and time through treatment selection, but only offers it', async () => {
    await advance('Can I book tomorrow at 4:30pm?');
    const result = await advance(answer);
    expect(result?.step).toBe('awaiting_pick');
    expect(state().offered.map(offer => [offer.date, offer.time])).toEqual([['2026-10-02', '16:30']]);
    assertNoReservation();
  });

  it('does not mistake an after-time request for permission to book that exact slot', async () => {
    const result = await advance('Can I book brow lamination tomorrow after 4:30pm?');
    expect(result?.step).toBe('awaiting_pick');
    assertNoReservation();
  });

  it('books the selected real slot once the client chooses it, with the treatment and no invented deposit', async () => {
    await advance(request, 'availability_check'); await advance(answer);
    assertNoReservation();
    const result = await advance('2 October at 4:30pm please');
    expect(result?.actionPerformed).toBe(true);
    expect(result?.step).toBe('held');
    expect(fixture.db.appointments).toHaveLength(1);
    expect(fixture.db.appointments[0]).toMatchObject({
      beautician_id: owner.id, client_id: client.id, treatment_id: 'brow',
      starts_at: '2026-10-02T16:30:00.000Z', status: 'confirmed', deposit_cents: 0,
    });
    expect(fixture.confirmations).toEqual([fixture.db.appointments[0].id]);
  });

  it('does not treat a repeated range as acceptance of its boundary slot', async () => {
    await advance(request); await advance(answer);
    const result = await advance('After 4:30 please');
    expect(result?.step).toBe('awaiting_pick');
    expect(result?.actionPerformed).toBe(false);
    assertNoReservation();
  });

  it('checks changed dates and time windows without offering mornings or reserving a choice', async () => {
    fixture.slots.push(slot('2026-10-03', '09:00'), slot('2026-10-03', '17:30'));
    await advance(request); await advance(answer);
    const result = await advance('None of those, on 3 October after 5pm please');
    expect(result?.step).toBe('awaiting_pick');
    expect(state().offered.map(offer => [offer.date, offer.time])).toEqual([['2026-10-03', '17:30']]);
    assertNoReservation();
  });

  it('honours the salon advance-booking limit when a whole month was requested', async () => {
    owner.booking_policy = { max_advance_days: 7 };
    await advance(request); await advance(answer);
    expect(state().offered.map(offer => offer.date)).toEqual(['2026-10-02']);
    expect(fixture.slotReads.every(read => read.days <= 7)).toBe(true);
    assertNoReservation();
  });

  it('keeps the time window when a treatment changes', async () => {
    await advance(request); await advance(answer);
    const result = await advance('Brow tint please');
    expect(result?.step).toBe('awaiting_pick');
    expect(state().treatment_id).toBe('tint');
    expect(state().offered.every(offer => offer.time >= '16:30' && offer.date <= '2026-10-31')).toBe(true);
    assertNoReservation();
  });

  it('keeps the time window when offering alternatives', async () => {
    fixture.slots = [slot('2026-10-02', '09:00'), ...['16:30', '17:00', '17:30', '18:00'].map(time => slot('2026-10-02', time)), slot('2026-11-01', '17:00')];
    await advance(request); await advance(answer);
    const result = await advance('None of those work, anything else?');
    expect(result?.step).toBe('awaiting_pick');
    expect(state().offered.every(offer => offer.time >= '16:30' && offer.date <= '2026-10-31')).toBe(true);
    assertNoReservation();
  });

  it('hands over when no offered time can meet the actual request instead of dropping the constraint', async () => {
    fixture.slots = [slot('2026-10-02', '09:00'), slot('2026-11-01', '17:00')];
    await advance(request);
    const result = await advance(answer);
    expect(result?.handOver).toBe(true);
    expect(result.reply).toMatch(/matching|asked for/i);
    assertNoReservation();
  });
});

describe('explicit booking preference bounds', () => {
  it('does not read a calendar date after a time as a later clock time', () => {
    const prefs = bookingPreferencesFrom('After 4 on 7 October', new Date('2026-10-01T11:00:00Z'));
    expect(prefs.afterTime).toBe('16:00');
    expect(prefs.dates).toEqual(['2026-10-07']);
  });

  it('does not turn after-a-patch-test wording into an arbitrary clock boundary', () => {
    expect(bookingPreferencesFrom('After a patch test on 7 October', new Date('2026-10-01T11:00:00Z')).afterTime).toBeUndefined();
  });

  it('filters both ends of a time window without changing salon wall times', () => {
    const prefs = bookingPreferencesFrom('This month after 4pm but before 6pm', new Date('2026-10-01T11:00:00Z'));
    expect(slotsWithinBookingPreferences(['15:30', '16:00', '17:00', '18:00', '18:30'].map(time => slot('2026-10-02', time)), prefs).map(item => item.time)).toEqual(['16:00', '17:00', '18:00']);
    expect(prefs.toDate).toBe('2026-10-31');
  });

  it('lets an explicit new date/time preference replace the old one', () => {
    const old = bookingPreferencesFrom(request, new Date('2026-10-01T11:00:00Z'));
    const next = bookingPreferencesFrom('Tomorrow at 11am instead', new Date('2026-10-01T11:00:00Z'), old);
    expect(slotsWithinBookingPreferences(fixture.slots.concat(slot('2026-10-02', '11:00')), next)).toEqual([slot('2026-10-02', '11:00')]);
  });

  it('permits flexible times only when the client explicitly says any time', () => {
    const old = bookingPreferencesFrom(request, new Date('2026-10-01T11:00:00Z'));
    const next = bookingPreferencesFrom('Any time is fine', new Date('2026-10-01T11:00:00Z'), old);
    expect(slotsWithinBookingPreferences(fixture.slots, next).some(item => item.time === '09:00')).toBe(true);
    expect(next.toDate).toBe('2026-10-31');
  });
});
