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

const db = { appointments: [], stripe_events: [], transactions: [], beauticians: [], ai_actions: [], clients: [] };
const counts = { stripe_events: 0, transactions: 0 };
let eventsError = null;
// What STRIPE says it has sent in the last 24h, which is the only witness
// independent of the pipe that broke. 'THROW' = we could not even ask.
let stripeRecentEvents = 0;
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
    // neq and limit arrived with the rescue alert on 31 August 2026: the
    // rescue now claims the status transition with
    // `.update({status:'confirmed'}).neq('status','confirmed').select('id')`
    // and reads the ai_actions ledger with `.limit(1)`, so the fake has to
    // understand both or the rescue silently stops confirming anything.
    neq(c, v) { filters.push(r => r[c] !== v); return b; },
    limit(n) { filters.push(() => true); b._limit = n; return b; },
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
      this.events = { list: async () => {
        if (stripeRecentEvents === 'THROW') throw new Error('stripe unreachable');
        return { data: stripeRecentEvents > 0 ? [{ id: 'evt_1' }] : [] };
      } };
    }
  },
}));
const toldClient = [];
const toldEllie = [];
vi.mock('../../src/lib/outbound-guard.js', () => ({
  guardedSend: async (args) => { toldClient.push(args); return { delivered: true }; },
}));
vi.mock('../../src/services/messaging.js', () => ({ sendOnChannel: async () => true }));
vi.mock('../../src/services/push-notifications.js', () => ({
  pushTeamUpdate: async (...args) => { toldEllie.push(args); return true; },
  // The rescue was the quietest path in the product: it repaired a paid
  // booking, raised a Sentry message and told the owner nothing at all.
  pushBookingConfirmed: async (...args) => { toldEllie.push(['booking_confirmed', ...args]); return { delivered: 1, sent: 1 }; },
}));
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
  // Stripe connected: every booking in this file COULD have been paid for, so
  // an unpaid one is a real abandoned checkout. A salon with no Stripe account
  // never asked anybody for the money, and cleanup leaves those alone.
  db.beauticians.push({
    id: 'b1', business_name: 'Ellindigo', booking_slug: 'ellindigo',
    stripe_account_id: 'acct_1', stripe_onboarding_complete: true,
  });
  counts.stripe_events = 5; counts.transactions = 3;
  stripeRecentEvents = 0;
  eventsError = null; piStatus.clear(); updates.length = 0;
  toldClient.length = 0; toldEllie.length = 0;
  db.clients.push({ id: 'c1', first_name: 'Charlotte', phone: '07700900123', email: 'charlotte@example.com', whatsapp_id: null });
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

  // A genuinely quiet day is not an outage: nothing from Stripe, nothing in our
  // own books, nothing recorded. Only then may the sweep run.
  it('still runs on a quiet day with no events and no payments', async () => {
    db.appointments.push(stale());
    counts.stripe_events = 0; counts.transactions = 0;
    stripeRecentEvents = 0;
    const r = await cleanupStaleBookings();
    expect(r.held).toBeUndefined();
    expect(r.cancelled).toBe(1);
  });

  // THE 5 AUGUST SHAPE, asked of the right witness.
  //
  // "Quiet day or deaf?" used to be answered from our own transactions table,
  // but almost every row in there is written BY the webhook, so killing the
  // webhook took both readings to zero together and the breaker called it a
  // quiet day. Bookings taken through conversational booking or a resent
  // payment link leave no transaction row at all until the webhook lands, so
  // there was nothing to see. Stripe is the only party that knows.
  it('holds when Stripe has been sending events and we have recorded none of them', async () => {
    db.appointments.push(stale());
    counts.stripe_events = 0;   // stripe_events had ZERO rows for the life of the account
    counts.transactions = 0;    // and nothing in our own books to hint at it
    stripeRecentEvents = 12;    // while Stripe was firing away

    const r = await cleanupStaleBookings();
    expect(r.held).toBe(true);
    expect(r.cancelled).toBe(0);
    expect(r.reason).toMatch(/stripe_events/i);
    expect(db.appointments[0].status).toBe('pending');
    expect(updates.filter(u => u.payload.status === 'cancelled')).toHaveLength(0);
  });

  it('holds when Stripe cannot be asked at all, rather than reading silence as consent', async () => {
    db.appointments.push(stale());
    counts.stripe_events = 0; counts.transactions = 0;
    stripeRecentEvents = 'THROW';

    const r = await cleanupStaleBookings();
    expect(r.held).toBe(true);
    expect(r.cancelled).toBe(0);
    expect(db.appointments[0].status).toBe('pending');
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
    // AND SHE IS TOLD. Until 31 August 2026 this branch repaired the booking
    // in complete silence: the only trace was a Sentry message, and the owner
    // ended up with a paid appointment in her diary she had heard nothing
    // about. That is the case where she most needs telling.
    expect(toldEllie.some(a => a[0] === 'booking_confirmed')).toBe(true);
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

/**
 * An auto-cancellation nobody hears about.
 *
 * Both the "your slot was released" message and the push to Ellie sat inside a
 * freshness window keyed on payment_expires_at, and that column is only ever
 * written when booking_policy.payment_buffer_enabled is on, which it is not by
 * default. So on an ordinary booking the window was never satisfied: the slot
 * vanished, the client carried on believing she had an appointment, and Ellie
 * was never told the time was free again.
 */
describe('somebody is always told when a slot is released', () => {
  const settle = () => new Promise(r => setTimeout(r, 0));

  it('tells the client and Ellie even with no payment_expires_at on the row', async () => {
    db.appointments.push(stale({
      payment_expires_at: null,
      created_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
    }));

    const r = await cleanupStaleBookings();
    await settle();

    expect(r.cancelled).toBe(1);
    expect(toldClient, 'the client was not told her slot had gone').toHaveLength(1);
    expect(toldClient[0].messageType).toBe('payment_link');
    expect(toldEllie, 'Ellie was not told the slot was free again').toHaveLength(1);
  });

  it('still stays quiet about a day-old backlog row being swept up', async () => {
    db.appointments.push(stale({
      payment_expires_at: null,
      created_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
    }));

    const r = await cleanupStaleBookings();
    await settle();

    expect(r.cancelled).toBe(1);
    expect(toldClient).toHaveLength(0);
    expect(toldEllie).toHaveLength(0);
  });
});
