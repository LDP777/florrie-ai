/**
 * Booking a client in across several messages, end to end.
 *
 * The 28 Jul incident is the reason this file is careful rather than cheerful.
 * Every assertion here is about one of three things:
 *   - Florrie only ever says a time that came out of the real diary.
 *   - She only ever says a booking happened when a row was actually written.
 *   - When she cannot check, she says so, and never says "nothing is free".
 *
 * The sandbox has no route to Supabase or Stripe, so both are stubbed. The
 * stub is a small in-memory PostgREST: enough filtering to make getFreeSlots
 * behave, and it records every write so the test can inspect what was booked.
 */
// The public address of THIS api, which is what the Checkout success_url has
// to point at. Set before any import so lib/public-url.js sees it.
process.env.PUBLIC_API_URL = 'https://api.florrie.test';

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { checkReplyClaims } from '../../src/lib/reply-claims-guard.js';
import { totalApplicationFee } from '../../src/lib/platform-fees.js';

// ---------------------------------------------------------------------------
// The fake database
// ---------------------------------------------------------------------------

const db = {
  clients: [], booking_conversations: [], appointments: [], hours_exceptions: [],
  consultation_responses: [], patch_tests: [], ai_actions: [], treatments: [],
};
// Errors a test wants a given table to return instead of rows.
const failing = new Map();
// A one-shot error for the next insert into a table (the double-book race).
const insertErrorOnce = new Map();
const writes = [];

let idCounter = 0;
const nextId = (prefix) => `${prefix}_${++idCounter}`;

function compare(a, b) {
  if (a === b) return 0;
  return String(a) < String(b) ? -1 : 1;
}

function makeBuilder(table) {
  const filters = [];
  let pending = null;
  let sort = null;

  const rowsNow = () => db[table] || [];
  const matching = () => rowsNow().filter(r => filters.every(f => f(r)));

  const settle = () => {
    if (failing.has(table)) return { data: null, error: failing.get(table) };

    if (pending?.op === 'insert') {
      if (insertErrorOnce.has(table)) {
        const err = insertErrorOnce.get(table);
        insertErrorOnce.delete(table);
        return { data: null, error: err };
      }
      const payload = Array.isArray(pending.payload) ? pending.payload : [pending.payload];
      const created = payload.map(p => ({ id: nextId(table), management_token: nextId('mt'), ...p }));
      db[table].push(...created);
      writes.push({ table, op: 'insert', rows: created });
      return { data: created.length === 1 ? created[0] : created, error: null };
    }
    if (pending?.op === 'upsert') {
      const p = pending.payload;
      const existing = db[table].find(r =>
        r.beautician_id === p.beautician_id && r.client_id === p.client_id);
      if (existing) Object.assign(existing, p);
      else db[table].push({ id: nextId(table), ...p });
      writes.push({ table, op: 'upsert', rows: [p] });
      return { data: null, error: null };
    }
    if (pending?.op === 'update') {
      const hit = matching();
      hit.forEach(r => Object.assign(r, pending.payload));
      writes.push({ table, op: 'update', rows: hit, payload: pending.payload });
      return { data: hit, error: null };
    }
    if (pending?.op === 'delete') {
      const hit = new Set(matching());
      db[table] = db[table].filter(r => !hit.has(r));
      writes.push({ table, op: 'delete', rows: [...hit] });
      return { data: null, error: null };
    }

    let out = matching();
    if (sort) out = out.slice().sort((a, b) => (sort.asc ? 1 : -1) * compare(a[sort.col], b[sort.col]));
    return { data: out, error: null };
  };

  const b = {
    select: () => b,
    insert: (payload) => { pending = { op: 'insert', payload }; return b; },
    upsert: (payload) => { pending = { op: 'upsert', payload }; return b; },
    update: (payload) => { pending = { op: 'update', payload }; return b; },
    delete: () => { pending = { op: 'delete' }; return b; },
    eq: (c, v) => { filters.push(r => String(r[c]) === String(v)); return b; },
    neq: (c, v) => { filters.push(r => String(r[c]) !== String(v)); return b; },
    gte: (c, v) => { filters.push(r => compare(r[c], v) >= 0); return b; },
    lte: (c, v) => { filters.push(r => compare(r[c], v) <= 0); return b; },
    gt: (c, v) => { filters.push(r => compare(r[c], v) > 0); return b; },
    lt: (c, v) => { filters.push(r => compare(r[c], v) < 0); return b; },
    in: (c, vs) => { filters.push(r => vs.map(String).includes(String(r[c]))); return b; },
    is: () => b,
    or: () => b,
    not: (c, _op, list) => {
      const banned = String(list).replace(/[()]/g, '').split(',');
      filters.push(r => !banned.includes(String(r[c])));
      return b;
    },
    order: (col, opts) => { sort = { col, asc: opts?.ascending !== false }; return b; },
    limit: () => b,
    single: () => { const r = settle(); return Promise.resolve(Array.isArray(r.data) ? { ...r, data: r.data[0] || null } : r); },
    maybeSingle: () => { const r = settle(); return Promise.resolve(Array.isArray(r.data) ? { ...r, data: r.data[0] || null } : r); },
    then: (resolve, reject) => Promise.resolve(settle()).then(resolve, reject),
  };
  return b;
}

vi.mock('../../src/config.js', () => ({
  supabase: { from: (table) => makeBuilder(table) },
}));

// ---------------------------------------------------------------------------
// The fake Stripe
// ---------------------------------------------------------------------------

const stripeCalls = { sessions: [], customers: [] };
let stripeThrows = false;

vi.mock('stripe', () => ({
  default: class {
    constructor() {
      this.customers = {
        create: async (args) => { stripeCalls.customers.push(args); return { id: 'cus_fake' }; },
      };
      this.checkout = {
        sessions: {
          create: async (args) => {
            if (stripeThrows) throw new Error('stripe is down');
            stripeCalls.sessions.push(args);
            return { url: 'https://checkout.stripe.com/c/pay/cs_test_fake', payment_intent: 'pi_fake' };
          },
        },
      };
    }
  },
}));

vi.mock('../../src/services/notifications.js', () => ({
  notifyBookingConfirmed: async () => true,
}));

// Everything this module told anybody until 31 August 2026 went to the CLIENT.
// It imported no push helper at all, so a client could book herself in over
// WhatsApp and the only person who never found out was the owner.
const ownerTold = [];
vi.mock('../../src/services/booking-confirmed-alert.js', () => ({
  announceBookingConfirmed: async (appointmentId, opts) => {
    ownerTold.push({ appointmentId, ...opts });
    return { announced: true, delivered: 1, channel: 'push' };
  },
  claimConfirmed: async () => ({ won: true, reason: 'transitioned' }),
  BOOKING_CONFIRMED_ACTION: 'booking_confirmed',
}));

const { advanceBookingConversation, heldBookingClaimContext, HOLD_MINUTES, SESSION_GRACE_MINUTES } =
  await import('../../src/services/conversational-booking.js');

// ---------------------------------------------------------------------------
// The salon
// ---------------------------------------------------------------------------

const HOURS = {
  mon: { start: '09:00', end: '20:00' }, tue: { start: '09:00', end: '20:00' },
  wed: { start: '09:00', end: '20:00' }, thu: { start: '09:00', end: '20:00' },
  fri: { start: '09:00', end: '20:00' }, sat: null, sun: null,
};

const BEAUTICIAN = {
  id: 'b1', first_name: 'Ellie', business_name: 'Ellie Beauty',
  working_hours: HOURS, timezone: 'Europe/London', booking_slug: 'ellie',
  stripe_account_id: 'acct_1', stripe_onboarding_complete: true,
  payment_settings: { deposit_amount: '£10' }, booking_policy: {},
};

const CLIENT = { id: 'c1', first_name: 'Sasha' };

const TREATMENTS = [
  { id: 't_classic', name: 'Classic Lash Extensions', duration_minutes: 90, buffer_minutes: 15, price_cents: 5000, deposit_cents: 0, deposit_percent: 20, requires_patch_test: false, requires_consultation: false },
  { id: 't_hybrid', name: 'Hybrid Lash Extensions', duration_minutes: 120, buffer_minutes: 15, price_cents: 6500, deposit_cents: 1500, deposit_percent: 0, requires_patch_test: false, requires_consultation: false },
  { id: 't_lift', name: 'Lash Lift', duration_minutes: 45, buffer_minutes: 0, price_cents: 3500, deposit_cents: 1000, deposit_percent: 0, requires_patch_test: true, requires_consultation: false },
  { id: 't_brow', name: 'Brow Lamination', duration_minutes: 45, buffer_minutes: 0, price_cents: 3000, deposit_cents: 1000, deposit_percent: 0, requires_patch_test: false, requires_consultation: true },
];

const ctx = (over = {}) => ({ treatments: TREATMENTS, treatmentsError: null, patchTest: null, ...over });

// A Friday morning in BRITISH SUMMER TIME. The salon clock reads 09:05, so the
// UTC instant is 08:05. Everything Florrie says must be in the 09:05 frame.
const BST_FRIDAY_WALL = '2026-08-07T09:05:00';
function freezeSalonClock() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-07T08:05:00.000Z'));
}

const say = (message, intent = 'booking_request', over = {}) =>
  advanceBookingConversation({
    beautician: BEAUTICIAN, client: CLIENT, message,
    classification: { intent, confidence: 1 }, context: ctx(over),
  });

beforeEach(() => {
  vi.useRealTimers();
  for (const t of Object.keys(db)) db[t] = [];
  db.clients.push({ id: 'c1', beautician_id: 'b1', first_name: 'Sasha', last_name: 'Rowe', email: 'sasha@example.com', phone: '07700900123', stripe_customer_id: null, blocked_at: null });
  failing.clear();
  insertErrorOnce.clear();
  writes.length = 0;
  stripeCalls.sessions.length = 0;
  stripeCalls.customers.length = 0;
  stripeThrows = false;
  idCounter = 0;
  ownerTold.length = 0;
});

const state = () => db.booking_conversations[0];
const held = () => db.appointments.filter(a => a.booked_via === 'ai_front_desk');

// ---------------------------------------------------------------------------

describe('step 1 and 2: working out what she wants', () => {
  it('asks ONE question when "lashes" could be three treatments, and names no time', () => {
    freezeSalonClock();
    return say('any chance of lashes friday?').then(r => {
      expect(r.reply).toContain('Classic Lash Extensions');
      expect(r.reply).toContain('Lash Lift');
      // The guard with an empty allow-list refuses ANY time, which is the
      // strongest possible statement that this reply names none.
      expect(checkReplyClaims(r.reply, { allowedTimes: [] }).ok).toBe(true);
      expect(state().step).toBe('awaiting_treatment');
    });
  });

  it('goes straight to offering times when she names the treatment', async () => {
    freezeSalonClock();
    const r = await say('can I book a hybrid lash set please');
    expect(state().step).toBe('awaiting_pick');
    expect(state().treatment_id).toBe('t_hybrid');
    expect(r.allowedTimes.length).toBeGreaterThan(1);
  });

  it('leaves a plain availability question to the normal reply path', async () => {
    freezeSalonClock();
    expect(await say('are you free next week?', 'availability_check')).toBeNull();
  });
});

describe('step 3: what she is allowed to offer', () => {
  it('offers between two and four times, all of them genuinely free', async () => {
    freezeSalonClock();
    // 10:00 to 13:00 is booked solid, so nothing inside it may be offered.
    db.appointments.push({ id: 'a_busy', beautician_id: 'b1', status: 'confirmed', starts_at: '2026-08-07T10:00:00.000Z', ends_at: '2026-08-07T13:00:00.000Z' });

    const r = await say('can I book a lash lift please, friday');
    const offered = state().offered;
    expect(offered.length).toBeGreaterThanOrEqual(2);
    expect(offered.length).toBeLessThanOrEqual(4);

    for (const o of offered) {
      expect(o.iso >= '2026-08-07T13:00:00.000Z' || o.iso < '2026-08-07T10:00:00.000Z').toBe(true);
      // Wall frame: the time in the offer IS the string, never a conversion.
      expect(o.time).toBe(o.iso.slice(11, 16));
    }
    // And the reply itself passes the guard against exactly that list.
    expect(checkReplyClaims(r.reply, { allowedTimes: offered.map(o => o.time) }).ok).toBe(true);
  });

  it('honours the salon wall clock in BST rather than the UTC instant', async () => {
    freezeSalonClock(); // 09:05 salon time, 08:05 UTC
    await say('can I book a hybrid lash set');
    // Nothing before the salon opens, nothing in the past, and crucially
    // nothing at 08:xx: an Intl conversion would have offered an hour early.
    for (const o of state().offered) {
      expect(o.time >= '09:00').toBe(true);
      expect(o.iso.slice(0, 10) >= BST_FRIDAY_WALL.slice(0, 10)).toBe(true);
    }
  });

  it('keeps a patch-test treatment at least 24 hours out', async () => {
    freezeSalonClock();
    await say('lash lift please', 'booking_request', { patchTest: { status: 'none', treatmentsNeedingTest: ['Lash Lift'] } });
    for (const o of state().offered) {
      expect(new Date(o.iso).getTime() - new Date(`${BST_FRIDAY_WALL}Z`).getTime()).toBeGreaterThanOrEqual(24 * 3600 * 1000);
    }
  });

  it('says it could NOT check, never that nothing is free, when the diary read fails', async () => {
    freezeSalonClock();
    failing.set('appointments', { message: 'column appointments.startz_at does not exist', code: '42703' });
    const r = await say('can I book a hybrid lash set');
    expect(r.handOver).toBe(true);
    expect(r.reply).toBe('Let me check my book and come straight back to you.');
    expect(r.reply.toLowerCase()).not.toContain('nothing');
    expect(held()).toHaveLength(0);
  });

  it('refuses to speak at all when the treatment menu could not be read', async () => {
    freezeSalonClock();
    const r = await advanceBookingConversation({
      beautician: BEAUTICIAN, client: CLIENT, message: 'can I book lashes',
      classification: { intent: 'booking_request', confidence: 1 },
      context: ctx({ treatments: [], treatmentsError: { message: 'boom' } }),
    });
    expect(r.handOver).toBe(true);
    expect(r.reply).toBe('Let me check my book and come straight back to you.');
  });
});

describe('step 4 and 5: she picks, the slot is held, the deposit link goes out', () => {
  async function offerThenPick(pick) {
    freezeSalonClock();
    await say('can I book a hybrid lash set friday');
    const offered = state().offered;
    const r = await say(pick, 'unknown');
    return { r, offered };
  }

  it('books the 4 o\'clock one when she says "the 4 one"', async () => {
    freezeSalonClock();
    await say('can I book a hybrid lash set friday');
    // Force a known offer list so the assertion is about the language, not
    // about which three slots the spread happened to choose.
    state().offered = [
      { iso: '2026-08-07T15:30:00.000Z', date: '2026-08-07', time: '15:30' },
      { iso: '2026-08-07T16:00:00.000Z', date: '2026-08-07', time: '16:00' },
      { iso: '2026-08-07T19:00:00.000Z', date: '2026-08-07', time: '19:00' },
    ];

    const r = await say('the 4 one please', 'unknown');

    expect(held()).toHaveLength(1);
    const appt = held()[0];
    // Wall time, stored as the wall clock inside the UTC slot. An Intl
    // conversion would have written 15:00Z and put her in an hour early.
    expect(appt.starts_at).toBe('2026-08-07T16:00:00.000Z');
    // 120 minutes plus a 15 minute buffer.
    expect(appt.ends_at).toBe('2026-08-07T18:15:00.000Z');
    expect(appt.status).toBe('pending');
    expect(appt.booked_via).toBe('ai_front_desk');
    expect(r.actionPerformed).toBe(true);
    expect(r.reply).toContain('https://checkout.stripe.com/');
    expect(r.reply).toContain('4pm');
    expect(state().step).toBe('held');
  });

  it('charges the right deposit and the right platform fee', async () => {
    freezeSalonClock();
    await say('can I book a hybrid lash set friday');
    state().offered = [{ iso: '2026-08-07T16:00:00.000Z', date: '2026-08-07', time: '16:00' }];
    const r = await say('yes please', 'unknown');

    // Hybrid has a flat £15 deposit, so that is what is asked for.
    expect(held()[0].deposit_cents).toBe(1500);
    expect(r.reply).toContain('£15');

    const session = stripeCalls.sessions[0];
    expect(session.line_items[0].price_data.unit_amount).toBe(1500);
    // Destination charge: Florrie's cut PLUS the estimated Stripe fee, or the
    // platform pays Stripe out of its own pocket on every booking.
    expect(session.payment_intent_data.application_fee_amount).toBe(totalApplicationFee(1500));
    expect(session.payment_intent_data.transfer_data.destination).toBe('acct_1');
    // The existing checkout.session.completed handler keys off this.
    expect(session.metadata.appointment_id).toBe(held()[0].id);
    // Stripe rejects anything under 30 minutes from when IT receives the call,
    // so asking for exactly HOLD_MINUTES loses the race to network latency and
    // the session, and therefore the deposit link, never exists. The hold is
    // extended by the same grace so a released slot still cannot be paid for.
    expect(session.expires_at).toBe(
      Math.floor(Date.now() / 1000) + (HOLD_MINUTES + SESSION_GRACE_MINUTES) * 60,
    );
    expect(session.expires_at - Math.floor(Date.now() / 1000)).toBeGreaterThan(30 * 60);
  });

  it('uses the percentage deposit when the treatment has one', async () => {
    freezeSalonClock();
    await say('classic lash extensions please');
    state().offered = [{ iso: '2026-08-07T16:00:00.000Z', date: '2026-08-07', time: '16:00' }];
    await say('yes please', 'unknown');
    // 20% of £50.
    expect(held()[0].deposit_cents).toBe(1000);
  });

  it('asks rather than guessing when the pick fits two offers', async () => {
    freezeSalonClock();
    await say('can I book a hybrid lash set');
    state().offered = [
      { iso: '2026-08-07T16:00:00.000Z', date: '2026-08-07', time: '16:00' },
      { iso: '2026-08-10T16:00:00.000Z', date: '2026-08-10', time: '16:00' },
    ];
    const r = await say('the 4 one', 'unknown');
    expect(held()).toHaveLength(0);
    expect(r.reply).toContain('did you mean');
    expect(checkReplyClaims(r.reply, { allowedTimes: ['16:00'] }).ok).toBe(true);
  });

  it('sends a consultation-form treatment to the booking page instead of booking blind', async () => {
    freezeSalonClock();
    await say('brow lamination please');
    state().offered = [{ iso: '2026-08-07T16:00:00.000Z', date: '2026-08-07', time: '16:00' }];
    const r = await say('yes please', 'unknown');
    expect(held()).toHaveLength(0);
    expect(r.reply).toContain('/book/ellie');
    expect(r.reply).toContain('form');
  });
});

describe('the race: the slot goes between offering it and holding it', () => {
  it('apologises and re-offers when the diary no longer has it', async () => {
    freezeSalonClock();
    await say('can I book a hybrid lash set friday');
    state().offered = [
      { iso: '2026-08-07T16:00:00.000Z', date: '2026-08-07', time: '16:00' },
      { iso: '2026-08-07T19:00:00.000Z', date: '2026-08-07', time: '19:00' },
    ];
    // Somebody else took 16:00 while she was deciding.
    db.appointments.push({ id: 'a_taken', beautician_id: 'b1', status: 'confirmed', starts_at: '2026-08-07T16:00:00.000Z', ends_at: '2026-08-07T18:15:00.000Z' });

    const r = await say('the 4 one', 'unknown');

    expect(held()).toHaveLength(0);
    expect(r.reply).toContain('just gone');
    // It must NOT name the time it lost: that time is not free, so saying it
    // would be the 28 Jul mistake with an apology attached.
    expect(r.reply).not.toContain('4pm');
    expect(checkReplyClaims(r.reply, { allowedTimes: r.allowedTimes }).ok).toBe(true);
    expect(state().step).toBe('awaiting_pick');
  });

  it('treats the database no-double-book violation as "somebody got there first"', async () => {
    freezeSalonClock();
    await say('can I book a hybrid lash set friday');
    state().offered = [
      { iso: '2026-08-07T16:00:00.000Z', date: '2026-08-07', time: '16:00' },
      { iso: '2026-08-07T19:00:00.000Z', date: '2026-08-07', time: '19:00' },
    ];
    // 23505: the unique-start index. The last few milliseconds went to someone else.
    insertErrorOnce.set('appointments', { code: '23505', message: 'duplicate key value' });

    const r = await say('the 4 one', 'unknown');
    expect(held()).toHaveLength(0);
    expect(r.reply).toContain('just gone');
    expect(r.actionPerformed).toBe(false);
  });

  it('gives the slot straight back if the payment link cannot be created', async () => {
    freezeSalonClock();
    await say('can I book a hybrid lash set friday');
    state().offered = [{ iso: '2026-08-07T16:00:00.000Z', date: '2026-08-07', time: '16:00' }];
    stripeThrows = true;

    const r = await say('yes please', 'unknown');
    // A hold nobody can pay for is a slot quietly taken out of her diary.
    expect(held()[0].status).toBe('cancelled');
    expect(r.handOver).toBe(true);
    expect(r.reply).toBe('Let me check my book and come straight back to you.');
  });
});

describe('expiry', () => {
  it('does not let last week\'s half-booking hijack a fresh hello', async () => {
    freezeSalonClock();
    db.booking_conversations.push({
      id: 'bc_old', beautician_id: 'b1', client_id: 'c1', step: 'awaiting_pick',
      treatment_id: 't_hybrid', asked_count: 0,
      offered: [{ iso: '2026-07-31T16:00:00.000Z', date: '2026-07-31', time: '16:00' }],
      expires_at: '2026-08-01T09:00:00.000Z', // last week
    });

    // "the 4 one" against a dead offer is not a booking instruction.
    expect(await say('hiya! the 4 one', 'greeting')).toBeNull();
    expect(held()).toHaveLength(0);
  });

  it('still honours an offer made an hour ago', async () => {
    freezeSalonClock();
    await say('can I book a hybrid lash set friday');
    expect(state().step).toBe('awaiting_pick');
    vi.setSystemTime(new Date('2026-08-07T09:05:00.000Z')); // an hour later
    state().offered = [{ iso: '2026-08-07T16:00:00.000Z', date: '2026-08-07', time: '16:00' }];
    await say('yes please', 'unknown');
    expect(held()).toHaveLength(1);
  });
});

describe('after the hold', () => {
  async function holdOne() {
    freezeSalonClock();
    await say('can I book a hybrid lash set friday');
    state().offered = [{ iso: '2026-08-07T16:00:00.000Z', date: '2026-08-07', time: '16:00' }];
    await say('yes please', 'unknown');
    return held()[0];
  }

  it('lets Ellie send the held-slot draft, which the free-slot guard alone would refuse', async () => {
    const appt = await holdOne();
    // The send boundary recomputes free slots, and a held slot is not free, so
    // without this the ONE draft backed by a real appointment row would be the
    // one blocked. The time comes off the appointment, not off a promise.
    const claim = await heldBookingClaimContext('b1', 'c1');
    expect(claim.allowedTimes).toEqual(['16:00']);
    expect(claim.actionPerformed).toBe(true);
    expect(checkReplyClaims("Perfect, Friday 7 August at 4pm is held for you", claim).ok).toBe(true);
    expect(appt.status).toBe('pending');
  });

  it('goes back to refusing the claim once the hold has been released', async () => {
    const appt = await holdOne();
    appt.status = 'cancelled'; // the stale-booking cleanup did its job
    const claim = await heldBookingClaimContext('b1', 'c1');
    expect(claim.actionPerformed).toBe(false);
    expect(claim.allowedTimes).toEqual([]);
    expect(checkReplyClaims("Perfect, Friday 7 August at 4pm is held for you", claim).ok).toBe(false);
  });

  it('tells her plainly when the unpaid hold was released', async () => {
    const appt = await holdOne();
    appt.status = 'cancelled';
    const r = await say('has that gone through?', 'general_question');
    expect(r.reply).toContain('released');
    expect(db.booking_conversations).toHaveLength(0);
  });

  it('re-sends the same link rather than holding a second slot', async () => {
    await holdOne();
    const before = held().length;
    const r = await say('the link did not work, can you send it again?', 'general_question');
    expect(held()).toHaveLength(before);
    expect(r.reply).toContain('https://checkout.stripe.com/');
  });

  it('drops the negotiation and stands aside when she asks to cancel', async () => {
    await holdOne();
    expect(await say('actually can I cancel', 'cancellation')).toBeNull();
    expect(db.booking_conversations).toHaveLength(0);
  });
});

describe('when the state itself cannot be stored', () => {
  it('says nothing rather than offer times it will not remember offering', async () => {
    freezeSalonClock();
    // This is also the state of the world on the day this ships, before the
    // migration has been run: the table does not exist, so no offer is made
    // and no slot is held. Degraded, not dangerous.
    failing.set('booking_conversations', { message: 'relation "booking_conversations" does not exist', code: '42P01' });
    const r = await say('can I book a hybrid lash set friday');
    expect(r.handOver).toBe(true);
    expect(r.reply).toBe('Let me check my book and come straight back to you.');
    expect(held()).toHaveLength(0);
  });
});

describe('who Florrie will book', () => {
  it('never books a client Ellie has blocked', async () => {
    freezeSalonClock();
    db.clients[0].blocked_at = '2026-07-01T00:00:00.000Z';
    expect(await say('can I book a hybrid lash set friday')).toBeNull();
    expect(held()).toHaveLength(0);
  });
});

/**
 * THE OWNER, WHO WAS NEVER TOLD ANY OF THIS.
 *
 * 31 August 2026. The pilot salon owner: "there is no notification for when
 * people book now, only when they try and haven't paid deposit yet." This file
 * was written on 5 August and has never notified her once, by either of its two
 * endings:
 *
 *   - the zero-deposit branch confirms the appointment outright and speaks only
 *     to the client;
 *   - the deposit branch's Checkout success_url pointed at the frontend SPA,
 *     so /api/booking/confirm/:sessionId (which retrieves the session, checks
 *     payment_status server side, records the deposit and tells the owner)
 *     was structurally unreachable for every conversational booking. The only
 *     thing that could ever confirm one was the Stripe webhook, which is the
 *     very thing that had been dead for six weeks.
 */
describe('the owner finds out about a conversational booking', () => {
  // A salon with no deposit configured and a treatment that asks for none:
  // the booking is confirmed outright, exactly as the booking page does it.
  const NO_DEPOSIT_SALON = { ...BEAUTICIAN, payment_settings: {} };
  const FREE_TREATMENT = {
    id: 't_free', name: 'Brow Tint', duration_minutes: 30, buffer_minutes: 0,
    price_cents: 1500, deposit_cents: 0, deposit_percent: 0,
    requires_patch_test: false, requires_consultation: false,
  };

  const sayFree = (message, intent = 'booking_request') =>
    advanceBookingConversation({
      beautician: NO_DEPOSIT_SALON, client: CLIENT, message,
      classification: { intent, confidence: 1 },
      context: ctx({ treatments: [FREE_TREATMENT] }),
    });

  it('tells her when a booking with no deposit is confirmed on the spot', async () => {
    freezeSalonClock();
    await sayFree('can I book a brow tint friday');
    state().offered = [{ iso: '2026-08-07T16:00:00.000Z', date: '2026-08-07', time: '16:00' }];
    const r = await sayFree('yes please', 'unknown');

    const appt = db.appointments.find(a => a.booked_via === 'ai_front_desk');
    expect(appt.status).toBe('confirmed');
    expect(r.actionPerformed).toBe(true);

    expect(ownerTold).toHaveLength(1);
    expect(ownerTold[0].appointmentId).toBe(appt.id);
    expect(ownerTold[0].source).toBe('conversational_no_deposit');
    // The row was INSERTED already confirmed, so there is no transition left
    // to claim and claiming one would silence the only alert she gets.
    expect(ownerTold[0].claim).toBe(false);
  });

  it('sends the deposit Checkout back to our own confirm endpoint, not to the SPA', async () => {
    freezeSalonClock();
    await say('can I book a hybrid lash set friday');
    state().offered = [{ iso: '2026-08-07T16:00:00.000Z', date: '2026-08-07', time: '16:00' }];
    await say('yes please', 'unknown');

    const session = stripeCalls.sessions[0];
    expect(session.success_url).toContain('https://api.florrie.test/api/booking/confirm/{CHECKOUT_SESSION_ID}');
    expect(session.success_url).toContain('slug=ellie');
    expect(session.success_url).toContain(`mt=${held()[0].management_token}`);
    // It still lands the client on the same confirmed page afterwards, so
    // nothing she sees changes.
    expect(session.cancel_url).toContain('https://florrie.ai/book/ellie');
  });
});
