/**
 * Never give away a slot somebody has paid for.
 *
 * On 5 August two of Ellie's clients turned up for appointments this cleanup
 * had released. Both had paid; the money had left their accounts; one showed
 * her the receipt. Nothing in the cleanup was wrong on its own terms: it
 * cancels bookings whose deposit is not marked paid, and theirs was not,
 * because checkout.session.completed never arrived for the life of the account.
 *
 * `deposit_paid = false` means two different things, "she did not pay" and
 * "we never heard", and treating them as one is what cost her the afternoon.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const db = { appointments: [], stripe_events: [], transactions: [], beauticians: [], ai_actions: [] };
const counts = { stripe_events: 0, transactions: 0 };
let eventsError = null;
const piStatus = new Map();
const updates = [];

function builder(table) {
  const filters = [];
  let pending = null;
  let headCount = false;
  const rows = () => (db[table] || []).filter(r => filters.every(f => f(r)));
  const settle = () => {
    if (table === 'stripe_events' && eventsError) return { data: null, error: eventsError, count: null };
    if (headCount) return { data: null, error: null, count: counts[table] ?? rows().length };
    if (pending?.op === 'update') {
      const hit = rows();
      for (const r of hit) Object.assign(r, pending.payload);
      updates.push({ table, payload: pending.payload, ids: hit.map(r => r.id) });
      return { data: hit, error: null };
    }
    if (pending?.op === 'insert') return { data: [], error: null };
    return { data: rows(), error: null };
  };
  const b = {
    select(_c, opts) { if (opts?.head) headCount = true; return b; },
    update(p) { pending = { op: 'update', payload: p }; return b; },
    insert(p) { pending = { op: 'insert', payload: p }; return b; },
    eq(c, v) { filters.push(r => r[c] === v); return b; },
    in(c, v) { filters.push(r => v.includes(r[c])); return b; },
    is(c, v) { filters.push(r => (r[c] ?? null) === v); return b; },
    or() { return b; },
    gt() { return b; },
    lt() { return b; },
    gte() { return b; },
    lte() { return b; },
    maybeSingle() { const o = settle(); return Promise.resolve(o.error ? o : { data: (o.data || [])[0] || null, error: null }); },
    then(res, rej) { return Promise.resolve(settle()).then(res, rej); },
  };
  return b;
}

vi.mock('../../src/config.js', () => ({ supabase: { from: builder } }));
vi.mock('stripe', () => ({
  default: class {
    constructor() {
      this.paymentIntents = { retrieve: async (id) => {
        const st = piStatus.get(id);
        if (st === 'THROW') throw new Error('stripe unreachable');
        return { id, status: st || 'requires_payment_method' };
      } };
    }
  },
}));
vi.mock('../../src/lib/outbound-guard.js', () => ({ guardedSend: async () => ({ sent: false }) }));
vi.mock('../../src/services/messaging.js', () => ({ sendOnChannel: async () => true }));
vi.mock('../../src/services/push-notifications.js', () => ({ pushTeamUpdate: async () => true }));
vi.mock('@sentry/node', () => ({ captureMessage: () => {}, captureException: () => {} }));

process.env.STRIPE_SECRET_KEY = 'sk_test_x';
const { cleanupStaleBookings } = await import('../../src/services/cleanup.js');

const stale = (over = {}) => ({
  id: 'a1', beautician_id: 'b1', client_id: 'c1',
  starts_at: '2026-08-20T11:00:00Z', deposit_cents: 1000, deposit_paid: false,
  payment_expires_at: '2026-08-01T00:00:00Z', google_event_id: null,
  stripe_payment_intent_id: null, status: 'pending',
  treatments: { name: 'Hybrid stain' }, clients: { first_name: 'Charlotte' }, ...over,
});

beforeEach(() => {
  for (const t of Object.keys(db)) db[t] = [];
  db.beauticians.push({ id: 'b1', business_name: 'Ellindigo', booking_slug: 'ellindigo' });
  counts.stripe_events = 5; counts.transactions = 3;
  eventsError = null; piStatus.clear(); updates.length = 0;
});

describe('the breaker: do not release anything while we are deaf to Stripe', () => {
  it('holds every booking when no webhook events have arrived but card money has', async () => {
    db.appointments.push(stale());
    counts.stripe_events = 0;   // exactly the state of the account for its whole life
    counts.transactions = 4;    // and money still landing

    const r = await cleanupStaleBookings();
    expect(r.held).toBe(true);
    expect(r.cancelled).toBe(0);
    expect(db.appointments[0].status).toBe('pending');
    expect(updates.filter(u => u.payload.status === 'cancelled')).toHaveLength(0);
  });

  it('holds when it cannot even read stripe_events, rather than assuming the worst', async () => {
    db.appointments.push(stale());
    eventsError = { message: 'connection reset' };
    const r = await cleanupStaleBookings();
    expect(r.held).toBe(true);
    expect(r.cancelled).toBe(0);
  });

  // A genuinely quiet day is not an outage: no events AND no money is fine.
  it('still runs on a quiet day with no events and no payments', async () => {
    db.appointments.push(stale());
    counts.stripe_events = 0; counts.transactions = 0;
    const r = await cleanupStaleBookings();
    expect(r.held).toBeUndefined();
    expect(r.cancelled).toBe(1);
  });
});

describe('asking Stripe before taking a slot away', () => {
  it('rescues a booking Stripe says was paid, and does not cancel it', async () => {
    db.appointments.push(stale({ stripe_payment_intent_id: 'pi_paid' }));
    piStatus.set('pi_paid', 'succeeded');

    const r = await cleanupStaleBookings();
    expect(r.cancelled).toBe(0);
    expect(r.rescued).toBe(1);
    expect(db.appointments[0].status).toBe('confirmed');
    expect(db.appointments[0].deposit_paid).toBe(true);
    expect(db.appointments[0].deposit_status).toBe('paid');
  });

  it('leaves it alone when Stripe cannot be reached, rather than guessing', async () => {
    db.appointments.push(stale({ stripe_payment_intent_id: 'pi_unknown' }));
    piStatus.set('pi_unknown', 'THROW');
    const r = await cleanupStaleBookings();
    expect(r.cancelled).toBe(0);
    expect(db.appointments[0].status).toBe('pending');
  });

  it('still cancels one Stripe confirms was never paid', async () => {
    db.appointments.push(stale({ stripe_payment_intent_id: 'pi_no' }));
    piStatus.set('pi_no', 'requires_payment_method');
    const r = await cleanupStaleBookings();
    expect(r.cancelled).toBe(1);
    expect(db.appointments[0].status).toBe('cancelled');
  });
});
