/**
 * The app must not record a confirmation it did not send.
 *
 * `confirmation_sent_at` is shown on the appointment as dispute evidence —
 * "we confirmed this with you". notifyBookingConfirmed stamped it at the end
 * of the function unconditionally, after a run of `if` branches every one of
 * which can decline: no phone, no email, confirmations switched off, WhatsApp
 * unconfigured and no SMS key. A client quick-created from the new-appointment
 * sheet has a name and, optionally, a phone — there is no email field on that
 * form at all — so "no phone" is not an edge case, it is Tuesday.
 *
 * The result was the worst available outcome: silence to the client, and a
 * timestamp to Ellie saying otherwise. She would only find out by asking.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const db = { appointments: [], beauticians: [], clients: [], treatments: [] };
const updates = [];      // every write to appointments, so a stamp cannot hide

function makeBuilder(table) {
  const filters = [];
  let pending = null;
  const matching = () => (db[table] || []).filter(r => filters.every(f => f(r)));
  const settle = () => {
    if (pending?.op === 'update') {
      if (table === 'appointments') updates.push(pending.payload);
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
    neq() { return b; }, in() { return b; }, is() { return b; },
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
vi.mock('@sentry/node', () => ({ captureMessage: () => {}, captureException: () => {} }));

const { notifyBookingConfirmed } = await import('../../src/services/notifications.js');

/**
 * One appointment, joined exactly the way notifyBookingConfirmed selects it.
 * `client` is spread in, so a test can hand over a client with no phone.
 */
function seed(client, prefs = {}) {
  db.appointments = [{
    id: 'a1',
    beautician_id: 'b1',
    client_id: 'c1',
    starts_at: new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString(),
    price_cents: 3000,
    clients: { first_name: 'Sarah', phone: null, email: null, ...client },
    treatments: { name: 'Signature brows', duration_minutes: 30 },
    beauticians: { business_name: 'Ellindigo', first_name: 'Ellie', client_reminder_prefs: prefs },
  }];
}

beforeEach(() => {
  db.appointments = [];
  updates.length = 0;
});

describe('notifyBookingConfirmed tells the truth about what it did', () => {
  it('does not stamp a confirmation for a client with no phone and no email', async () => {
    seed({ phone: null, email: null });

    const result = await notifyBookingConfirmed('a1');

    expect(result).toMatchObject({ sent: false, reason: 'no_contact_details' });
    // The assertion this file exists for. Before the fix this array contained
    // { confirmation_sent_at: <now> } and the UI believed it.
    expect(updates.filter(u => 'confirmation_sent_at' in u)).toHaveLength(0);
    expect(db.appointments[0].confirmation_sent_at).toBeUndefined();
  });

  it('does not stamp when the beautician has paused all outbound', async () => {
    seed({ phone: '07700900001' }, { paused: true });

    const result = await notifyBookingConfirmed('a1');

    expect(result).toMatchObject({ sent: false, reason: 'paused' });
    expect(updates.filter(u => 'confirmation_sent_at' in u)).toHaveLength(0);
  });

  it('says which appointment it could not find, rather than returning undefined', async () => {
    db.appointments = [];
    const result = await notifyBookingConfirmed('nope');
    expect(result).toMatchObject({ sent: false, reason: 'no_appointment' });
  });
});
