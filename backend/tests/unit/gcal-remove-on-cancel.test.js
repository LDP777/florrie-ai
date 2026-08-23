/**
 * The slot Ellie thinks is taken.
 *
 * When the deposit window closes on an unpaid booking, cleanupStaleBookings
 * cancels the appointment and texts the client to say her slot was released.
 * If that booking had been pushed to Google Calendar it also has to be removed
 * from there, or Ellie's diary and Florrie's diary stop agreeing.
 *
 * removeFromGoogleCalendar selected `google_calendar_token` and
 * `google_calendar_refresh_token`. Neither is a column. There is ONE column,
 * `google_calendar_tokens`, an encrypted JSONB blob holding
 * { access_token, refresh_token, expiry_date }, added by
 * supabase/migrations/004_integrations.sql:7. PostgREST rejected the whole
 * select, `b` came back null, and the function returned at its first guard
 * every time it was called.
 *
 * So: appointment cancelled, client told, event still sitting in her calendar
 * looking booked. She works around a slot that is actually free, or books over
 * it and double-books herself, and neither the app nor the calendar can tell
 * her which of them is wrong.
 *
 * The write half had the same bug: the refreshed access token was saved to
 * `google_calendar_token`, so even on the path where the read had worked, the
 * refresh was thrown away.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const PHANTOM = {
  beauticians: ['google_calendar_token', 'google_calendar_refresh_token'],
};

const db = { appointments: [], beauticians: [], ai_actions: [], clients: [], stripe_events: [], transactions: [] };
const updates = [];
const rejected = [];

function leafColumns(cols) {
  return String(cols).replace(/[()]/g, ',').split(',').map(s => s.trim()).filter(Boolean);
}

function builder(table) {
  const filters = [];
  let pending = null;
  let head = false;
  let bad = null;
  const rows = () => (db[table] || []).filter(r => filters.every(f => f(r)));
  const settle = () => {
    if (bad) return { data: null, error: { code: '42703', message: `column ${table}.${bad} does not exist` }, count: null };
    if (head) return { data: null, error: null, count: rows().length };
    if (pending?.op === 'update') {
      const hit = rows();
      for (const r of hit) Object.assign(r, pending.payload);
      updates.push({ table, payload: pending.payload });
      return { data: hit, error: null };
    }
    if (pending?.op === 'insert') return { data: [], error: null };
    return { data: rows(), error: null };
  };
  const b = {
    select(cols, opts) {
      if (opts?.head) head = true;
      // '*' asks for every column, including ones that exist, so it is never
      // the thing that gets rejected.
      if (cols && cols !== '*') {
        bad = leafColumns(cols).find(c => (PHANTOM[table] || []).includes(c)) || null;
        if (bad) rejected.push({ table, column: bad });
      }
      return b;
    },
    insert(p) { pending = { op: 'insert', payload: p }; return b; },
    update(p) { pending = { op: 'update', payload: p }; return b; },
    eq(c, v) { filters.push(r => r[c] === v); return b; },
    neq() { return b; }, in() { return b; },
    is(c, v) { filters.push(r => (r[c] ?? null) === v); return b; },
    not() { return b; }, or() { return b; },
    gt() { return b; }, lt() { return b; }, gte() { return b; }, lte() { return b; },
    like() { return b; }, order() { return b; }, limit() { return b; },
    maybeSingle() { const o = settle(); return Promise.resolve(o.error ? o : { data: (o.data || [])[0] || null, error: null }); },
    single() { const o = settle(); return Promise.resolve(o.error ? o : { data: (o.data || [])[0] || null, error: null }); },
    then(res, rej) { return Promise.resolve(settle()).then(res, rej); },
  };
  return b;
}

vi.mock('../../src/config.js', () => ({ supabase: { from: builder } }));
vi.mock('../../src/lib/outbound-guard.js', () => ({ guardedSend: async () => ({ delivered: true, decision: 'send' }) }));
vi.mock('../../src/services/messaging.js', () => ({ sendOnChannel: async () => ({ ok: true }) }));
vi.mock('../../src/services/push-notifications.js', () => ({ pushTeamUpdate: async () => true }));
vi.mock('@sentry/node', () => ({ captureMessage: () => {}, captureException: () => {} }));
// No Stripe key in this test, so the "are we hearing from Stripe" breaker is a
// no-op and every stale booking is genuinely releasable.
delete process.env.STRIPE_SECRET_KEY;

const calls = [];
let deleteStatus = 204;
let refreshOk = true;
global.fetch = vi.fn(async (url, opts = {}) => {
  calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body });
  if (String(url).includes('oauth2.googleapis.com/token')) {
    return refreshOk
      ? { ok: true, status: 200, json: async () => ({ access_token: 'fresh-token', expires_in: 3600 }), text: async () => '' }
      : { ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }), text: async () => 'invalid_grant' };
  }
  return { ok: deleteStatus < 300, status: deleteStatus, json: async () => ({}), text: async () => '' };
});

const { encrypt, decrypt } = await import('../../src/lib/crypto.js');
const { cleanupStaleBookings } = await import('../../src/services/cleanup.js');

const staleAppointment = (over = {}) => ({
  id: 'a1', beautician_id: 'b1', client_id: 'c1',
  starts_at: '2026-08-27T11:00:00Z',
  created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  deposit_cents: 1000, deposit_paid: false,
  payment_expires_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
  google_event_id: 'gcal_evt_1', stripe_payment_intent_id: null, status: 'pending',
  treatments: { name: 'Hybrid set' }, clients: { first_name: 'Charlotte' },
  ...over,
});

const gcalDeletes = () => calls.filter(c => c.method === 'DELETE' && c.url.includes('googleapis.com/calendar'));

beforeEach(() => {
  for (const t of Object.keys(db)) db[t] = [];
  calls.length = 0;
  updates.length = 0;
  rejected.length = 0;
  deleteStatus = 204;
  refreshOk = true;
  db.beauticians.push({
    id: 'b1', business_name: 'Ellindigo', booking_slug: 'ellindigo',
    google_calendar_connected: true,
    google_calendar_tokens: encrypt({ access_token: 'live-token', refresh_token: 'refresh-token', expiry_date: Date.now() + 3600_000 }),
    google_calendar_id: 'primary',
  });
});

describe('an auto-cancelled booking', () => {
  it('is removed from Google Calendar, not just from the app', async () => {
    db.appointments.push(staleAppointment());

    const result = await cleanupStaleBookings();
    // The removal is fired and not awaited, so let the microtask queue drain.
    await new Promise(r => setTimeout(r, 10));

    expect(result.cancelled).toBe(1);
    const deletes = gcalDeletes();
    expect(deletes).toHaveLength(1);
    expect(deletes[0].url).toContain('gcal_evt_1');
    expect(deletes[0].url).toContain('primary');
  });

  it('and the token lookup names no column that does not exist', async () => {
    db.appointments.push(staleAppointment());
    await cleanupStaleBookings();
    await new Promise(r => setTimeout(r, 10));

    expect(rejected).toEqual([]);
  });

  it('with no Google connection, nothing is attempted and nothing throws', async () => {
    db.beauticians[0].google_calendar_tokens = null;
    db.appointments.push(staleAppointment());

    const result = await cleanupStaleBookings();
    await new Promise(r => setTimeout(r, 10));

    expect(result.cancelled).toBe(1);
    expect(gcalDeletes()).toHaveLength(0);
  });

  it('with no calendar event on the booking, no delete is attempted', async () => {
    db.appointments.push(staleAppointment({ google_event_id: null }));

    await cleanupStaleBookings();
    await new Promise(r => setTimeout(r, 10));

    expect(gcalDeletes()).toHaveLength(0);
  });
});

describe('when the access token has gone stale', () => {
  beforeEach(() => { deleteStatus = 401; });

  it('refreshes, retries the delete, and saves the WHOLE blob back', async () => {
    db.appointments.push(staleAppointment());

    await cleanupStaleBookings();
    await new Promise(r => setTimeout(r, 10));

    // One refresh, and the delete attempted twice: once before, once after.
    expect(calls.filter(c => c.url.includes('oauth2.googleapis.com'))).toHaveLength(1);
    expect(gcalDeletes()).toHaveLength(2);

    const saved = updates.find(u => u.table === 'beauticians' && u.payload.google_calendar_tokens);
    expect(saved).toBeTruthy();
    const blob = decrypt(saved.payload.google_calendar_tokens);
    expect(blob.access_token).toBe('fresh-token');
    // The refresh token has to survive the write, or the next refresh has
    // nothing to refresh with.
    expect(blob.refresh_token).toBe('refresh-token');
  });

  it('and when Google refuses the refresh, the integration is marked disconnected', async () => {
    refreshOk = false;
    db.appointments.push(staleAppointment());

    await cleanupStaleBookings();
    await new Promise(r => setTimeout(r, 10));

    const disconnect = updates.find(u => u.table === 'beauticians' && u.payload.google_calendar_connected === false);
    expect(disconnect).toBeTruthy();
    expect(disconnect.payload.google_calendar_tokens).toBeNull();
    // No pointless retry against a token Google has already rejected.
    expect(gcalDeletes()).toHaveLength(1);
  });
});
