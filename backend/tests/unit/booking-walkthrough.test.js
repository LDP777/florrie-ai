/**
 * THE WALKTHROUGH. Does the whole thing actually work, on a busy diary?
 *
 * Every other test here checks one rule. This one plays the conversation the
 * way a client would and prints it, then goes back over what Florrie SAID and
 * checks it against the diary independently, without asking the code that
 * produced it. That distinction is the point: on 28 July she told somebody
 * "4.30 on Thursday is available" and the only thing that would have caught it
 * is exactly this, a check that does not trust the speaker.
 *
 * Run it on its own to read the transcript:
 *   npx vitest run tests/unit/booking-walkthrough.test.js --reporter=verbose
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { checkReplyClaims } from '../../src/lib/reply-claims-guard.js';
import { totalApplicationFee } from '../../src/lib/platform-fees.js';

const db = {
  clients: [], booking_conversations: [], appointments: [], hours_exceptions: [],
  consultation_responses: [], patch_tests: [], ai_actions: [], treatments: [],
};
const failing = new Map();
const insertErrorOnce = new Map();
const writes = [];
let idCounter = 0;
const nextId = (p) => `${p}_${++idCounter}`;

function makeBuilder(table) {
  const filters = [];
  let pending = null;
  let sort = null;
  const matching = () => (db[table] || []).filter(r => filters.every(f => f(r)));
  const settle = () => {
    if (failing.has(table)) return { data: null, error: failing.get(table) };
    if (pending?.op === 'insert') {
      if (insertErrorOnce.has(table)) {
        const err = insertErrorOnce.get(table); insertErrorOnce.delete(table);
        return { data: null, error: err };
      }
      const payload = Array.isArray(pending.payload) ? pending.payload : [pending.payload];
      const created = payload.map(p => ({ id: nextId(table), management_token: nextId('mt'), ...p }));
      db[table].push(...created);
      writes.push({ table, op: 'insert', rows: created });
      return { data: created, error: null };
    }
    if (pending?.op === 'update') {
      const rows = matching();
      for (const r of rows) Object.assign(r, pending.payload);
      writes.push({ table, op: 'update', rows });
      return { data: rows, error: null };
    }
    if (pending?.op === 'upsert') {
      const payload = pending.payload;
      const key = r => r.beautician_id === payload.beautician_id && r.client_id === payload.client_id;
      const found = (db[table] || []).find(key);
      if (found) { Object.assign(found, payload); return { data: [found], error: null }; }
      const created = { id: nextId(table), ...payload };
      db[table].push(created);
      return { data: [created], error: null };
    }
    if (pending?.op === 'delete') {
      db[table] = (db[table] || []).filter(r => !filters.every(f => f(r)));
      return { data: null, error: null };
    }
    let rows = matching();
    if (sort) rows = [...rows].sort((a, b) => (String(a[sort.col]) < String(b[sort.col]) ? -1 : 1) * (sort.asc ? 1 : -1));
    return { data: rows, error: null };
  };
  const b = {
    select() { return b; },
    insert(payload) { pending = { op: 'insert', payload }; return b; },
    update(payload) { pending = { op: 'update', payload }; return b; },
    upsert(payload) { pending = { op: 'upsert', payload }; return b; },
    delete() { pending = { op: 'delete' }; return b; },
    eq(c, v) { filters.push(r => r[c] === v); return b; },
    neq(c, v) { filters.push(r => r[c] !== v); return b; },
    in(c, v) { filters.push(r => v.includes(r[c])); return b; },
    is(c, v) { filters.push(r => (r[c] ?? null) === v); return b; },
    not(c, op, v) {
      if (op === 'in') { const list = String(v).replace(/[()]/g, '').split(','); filters.push(r => !list.includes(String(r[c]))); }
      else filters.push(r => (r[c] ?? null) !== null);
      return b;
    },
    gte(c, v) { filters.push(r => String(r[c]) >= String(v)); return b; },
    lte(c, v) { filters.push(r => String(r[c]) <= String(v)); return b; },
    gt(c, v) { filters.push(r => String(r[c]) > String(v)); return b; },
    lt(c, v) { filters.push(r => String(r[c]) < String(v)); return b; },
    order(col, o = {}) { sort = { col, asc: o.ascending !== false }; return b; },
    limit() { return b; },
    maybeSingle() { const o = settle(); return Promise.resolve(o.error ? o : { data: (o.data || [])[0] || null, error: null }); },
    single() { const o = settle(); return Promise.resolve(o.error ? o : { data: (o.data || [])[0] || null, error: null }); },
    then(res, rej) { return Promise.resolve(settle()).then(res, rej); },
  };
  return b;
}

vi.mock('../../src/config.js', () => ({ supabase: { from: (t) => makeBuilder(t) } }));

const stripeCalls = { sessions: [], customers: [] };
const refuseExpiryOnce = { value: false };
vi.mock('stripe', () => ({
  default: class {
    constructor() {
      this.customers = { create: async (a) => { stripeCalls.customers.push(a); return { id: 'cus_fake' }; } };
      this.checkout = { sessions: { create: async (a) => {
        stripeCalls.sessions.push(a);
        if (refuseExpiryOnce.value) {
          refuseExpiryOnce.value = false;
          throw new Error('Invalid timestamp: expires_at must be at least 30 minutes in the future');
        }
        return { url: 'https://checkout.stripe.com/c/pay/cs_live_a1B2c3D4', payment_intent: 'pi_fake' };
      } } };
    }
  },
}));
vi.mock('../../src/services/notifications.js', () => ({ notifyBookingConfirmed: async () => true }));

const { advanceBookingConversation } = await import('../../src/services/conversational-booking.js');

const HOURS = {
  mon: { start: '09:00', end: '20:00' }, tue: { start: '09:00', end: '20:00' },
  wed: { start: '09:00', end: '20:00' }, thu: { start: '09:00', end: '20:00' },
  fri: { start: '09:00', end: '20:00' }, sat: null, sun: null,
};
const BEAUTICIAN = {
  id: 'b1', first_name: 'Ellie', business_name: 'Ellindigo',
  working_hours: HOURS, timezone: 'Europe/London', booking_slug: 'ellindigo',
  stripe_account_id: 'acct_1', stripe_onboarding_complete: true,
  payment_settings: { deposit_amount: '£10' }, booking_policy: {},
};
const CLIENT = { id: 'c1', first_name: 'Sasha' };
const TREATMENTS = [
  { id: 't_classic', name: 'Classic Lash Extensions', duration_minutes: 60, buffer_minutes: 0, price_cents: 5000, deposit_cents: 1000, deposit_percent: 0, requires_patch_test: false, requires_consultation: false },
  { id: 't_brow', name: 'Brow Lamination', duration_minutes: 45, buffer_minutes: 0, price_cents: 3000, deposit_cents: 1000, deposit_percent: 0, requires_patch_test: false, requires_consultation: false },
];

// A genuinely busy Friday. Everything except three gaps is taken.
const BOOKED = [
  ['2026-08-07T09:00:00Z', '2026-08-07T11:00:00Z'],
  ['2026-08-07T11:00:00Z', '2026-08-07T13:00:00Z'],
  ['2026-08-07T13:00:00Z', '2026-08-07T15:30:00Z'],
  ['2026-08-07T17:00:00Z', '2026-08-07T19:00:00Z'],
];

function seed() {
  for (const t of Object.keys(db)) db[t] = [];
  db.clients.push({ id: 'c1', beautician_id: 'b1', first_name: 'Sasha', last_name: 'Rowe', email: 'sasha@example.com', phone: '07700900123', stripe_customer_id: null, blocked_at: null });
  for (const [s, e] of BOOKED) {
    db.appointments.push({ id: nextId('appt'), beautician_id: 'b1', client_id: 'someone_else', starts_at: s, ends_at: e, status: 'confirmed' });
  }
  // The whole of the following week is shut, so the only free time is Friday.
  for (const d of ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14']) {
    db.hours_exceptions.push({ beautician_id: 'b1', date: d, type: 'closed', start_time: null, end_time: null });
  }
  failing.clear(); insertErrorOnce.clear(); writes.length = 0;
  stripeCalls.sessions.length = 0; stripeCalls.customers.length = 0; refuseExpiryOnce.value = false;
}

const say = (message, intent = 'booking_request') =>
  advanceBookingConversation({
    beautician: BEAUTICIAN, client: CLIENT, message,
    classification: { intent, confidence: 1 },
    context: { treatments: TREATMENTS, treatmentsError: null, patchTest: null },
  });

/** Friday 7 August 2026, 09:05 on the salon clock. BST, so 08:05 UTC. */
function freezeSalonClock() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-07T08:05:00.000Z'));
}

/**
 * Independently: is this wall time actually free on the diary?
 * Deliberately does not call getFreeSlots. If both were wrong in the same way
 * this would agree with the bug.
 */
function reallyFree(dateWall, hhmm, durationMinutes) {
  const start = new Date(`${dateWall}T${hhmm}:00Z`).getTime();
  const end = start + durationMinutes * 60 * 1000;
  const open = new Date(`${dateWall}T09:00:00Z`).getTime();
  const close = new Date(`${dateWall}T20:00:00Z`).getTime();
  if (start < open || end > close) return false;
  return !db.appointments.some(a => {
    if (a.status === 'cancelled') return false;
    const s = new Date(a.starts_at).getTime();
    const e = new Date(a.ends_at).getTime();
    return start < e && end > s;
  });
}

/** Every clock time in a sentence, as HH:MM. */
function timesIn(text) {
  const out = [];
  for (const m of String(text).matchAll(/\b(\d{1,2})(?:[.:](\d{2}))?\s*(am|pm)\b/gi)) {
    let h = Number(m[1]) % 12;
    if (m[3].toLowerCase() === 'pm') h += 12;
    out.push(`${String(h).padStart(2, '0')}:${m[2] || '00'}`);
  }
  return out;
}

beforeEach(() => { vi.useRealTimers(); idCounter = 0; seed(); });

describe('the whole thing, on a diary with four bookings already in it', () => {
  it('offers only genuinely free times, takes the pick, and produces a real deposit link', async () => {
    freezeSalonClock();
    const script = [];

    script.push(['Sasha', 'hiya do you have anything for classic lashes today?']);
    const offer = await say(script[0][1]);
    script.push(['Florrie', offer.reply]);

    // 1. THE 28 JULY CHECK. Every time she just said, verified against the
    //    diary by something that has never spoken to getFreeSlots.
    const offered = timesIn(offer.reply);
    expect(offered.length).toBeGreaterThan(0);
    for (const t of offered) {
      expect(reallyFree('2026-08-07', t, 60), `Florrie offered ${t} and it is NOT free`).toBe(true);
    }
    // And she did not offer a time somebody is already in the chair for.
    expect(offered).not.toContain('09:00');
    expect(offered).not.toContain('12:00');
    expect(offered).not.toContain('14:00');
    expect(offered).not.toContain('18:00');
    // Nor anything before the salon opens or after it shuts.
    for (const t of offered) { expect(t >= '09:00').toBe(true); expect(t <= '19:00').toBe(true); }

    // 2. The client picks in the way a person actually does.
    const pick = offered[1] ? `the ${Number(offered[1].slice(0, 2)) % 12 || 12} one` : 'the first one';
    script.push(['Sasha', pick]);
    const held = await say(pick);
    script.push(['Florrie', held.reply]);

    // 3. A real row exists, at the time she said, and nothing was double booked.
    const booked = db.appointments.filter(a => a.booked_via === 'ai_front_desk');
    expect(booked).toHaveLength(1);
    expect(booked[0].status).toBe('pending');
    const bookedTime = String(booked[0].starts_at).slice(11, 16);
    expect(timesIn(held.reply)).toContain(bookedTime);
    expect(offered).toContain(bookedTime);

    // 4. The deposit link is real, and priced from the treatment.
    expect(held.reply).toContain('https://checkout.stripe.com/');
    const session = stripeCalls.sessions[0];
    expect(session.line_items[0].price_data.unit_amount).toBe(1000);
    expect(session.payment_intent_data.application_fee_amount).toBe(totalApplicationFee(1000));
    expect(session.payment_intent_data.transfer_data.destination).toBe('acct_1');
    // The webhook confirms on this and nothing else.
    expect(session.metadata.appointment_id).toBe(booked[0].id);
    expect(session.metadata.payment_type).toBe('deposit');
    // Stripe's floor is 30 minutes from when IT receives the call.
    expect(session.expires_at - Math.floor(Date.now() / 1000)).toBeGreaterThan(30 * 60);

    // 5. The claims guard passes it with the verified list, and would refuse a
    //    time that was never offered.
    expect(checkReplyClaims(held.reply, { allowedTimes: [bookedTime], actionPerformed: true }).ok).toBe(true);
    expect(checkReplyClaims(held.reply, { allowedTimes: [], actionPerformed: true }).ok).toBe(false);

    console.log('\n──────── TRANSCRIPT ────────');
    for (const [who, line] of script) console.log(`${who.padEnd(7)}: ${line}`);
    console.log(`\nDiary before : ${BOOKED.map(([s, e]) => `${s.slice(11, 16)}-${e.slice(11, 16)}`).join(', ')}`);
    console.log(`Offered      : ${offered.join(', ')}  (all verified free independently)`);
    console.log(`Held         : ${bookedTime} as ${booked[0].status}, deposit £10, ${booked[0].booked_via}`);
    console.log('────────────────────────────\n');
  });

  it('when the slot goes between the offer and the reply, it says so and re-offers', async () => {
    freezeSalonClock();
    const offer = await say('classic lashes today please');
    const offered = timesIn(offer.reply);

    // Somebody books the 4pm while Sasha is typing. Deliberately an on-the-hour
    // slot so the pick phrasing is not the thing under test here.
    const taken = offered.find(t => t.endsWith(':00')) || offered[0];
    db.appointments.push({
      id: nextId('appt'), beautician_id: 'b1', client_id: 'walk_in',
      starts_at: `2026-08-07T${taken}:00Z`, ends_at: `2026-08-07T${String(Number(taken.slice(0, 2)) + 1).padStart(2, '0')}:${taken.slice(3)}:00Z`,
      status: 'confirmed',
    });

    const r = await say(`the ${Number(taken.slice(0, 2)) % 12 || 12} one`);
    expect(r.reply).toContain('just gone');
    // Nothing was written for a slot that was not free.
    expect(db.appointments.filter(a => a.booked_via === 'ai_front_desk')).toHaveLength(0);
    // The one that went is not among the replacements.
    expect(timesIn(r.reply)).not.toContain(taken);
    // And every replacement is itself genuinely free, checked on ITS OWN date:
    // the re-offer rolls onto later days, so a Friday-only checker would be
    // asserting against the wrong diary.
    for (const s of db.booking_conversations[0].offered) {
      expect(reallyFree(s.date, s.time, 60), `re-offered ${s.date} ${s.time} and it is NOT free`).toBe(true);
    }
    console.log(`\nRace: ${taken} was taken mid-conversation. Florrie said:\n  "${r.reply}"\n`);
  });

  it('says it could not check rather than "nothing is free" when the diary read fails', async () => {
    freezeSalonClock();
    failing.set('appointments', { message: 'connection reset', code: '08006' });
    const r = await say('classic lashes today please');
    expect(r.handOver).toBe(true);
    expect(r.reply.toLowerCase()).not.toContain('nothing');
    expect(r.reply.toLowerCase()).not.toContain('fully booked');
    expect(db.appointments.filter(a => a.booked_via === 'ai_front_desk')).toHaveLength(0);
    console.log(`\nDiary unreadable. Florrie said:\n  "${r.reply}"\n`);
  });
});

/**
 * How a real person picks, and whether Florrie follows.
 *
 * Offers are "today at 3.30pm, 4pm or 7pm". Anything that does not resolve to
 * exactly one of those must ask again rather than guess, because guessing here
 * books somebody into the wrong slot and takes their deposit for it.
 */
describe('the ways people actually say which one', () => {
  const PHRASES = [
    ['4pm', '16:00'],
    ['the 4 one', '16:00'],
    ['4 please', '16:00'],
    ['ill take the 4', '16:00'],
    ['7pm works', '19:00'],
    ['the last one', '19:00'],
    ['the first one', '15:30'],
    ['3.30 please', '15:30'],
    ['half 3', '15:30'],
    ['half three', '15:30'],
    ['3:30pm', '15:30'],
    ['the 3 one', '15:30'],
    ['the early one', null],
    ['whenever suits', null],
  ];

  for (const [phrase, expected] of PHRASES) {
    it(`"${phrase}" ${expected ? `picks ${expected}` : 'asks again rather than guessing'}`, async () => {
      freezeSalonClock();
      await say('classic lashes today please');
      const r = await say(phrase);
      const booked = db.appointments.filter(a => a.booked_via === 'ai_front_desk');
      if (expected) {
        expect(booked, `"${phrase}" did not book anything`).toHaveLength(1);
        expect(String(booked[0].starts_at).slice(11, 16)).toBe(expected);
      } else {
        expect(booked, `"${phrase}" booked something and should not have`).toHaveLength(0);
      }
    });
  }
});

/**
 * The bare hour only resolves when it is genuinely unambiguous.
 *
 * "the 3 one" against a 3.30 offer is a person being normal. "the 3 one" when
 * both 3pm and 3.30pm are on the table is a person being unclear, and booking
 * one of them and taking a deposit for it is the wrong kind of confident.
 */
describe('a bare hour that could mean two things stays a question', () => {
  it('asks again when both 3pm and 3.30pm were offered', async () => {
    freezeSalonClock();
    // Free the afternoon so both land in the offer.
    db.appointments = db.appointments.filter(a => !String(a.starts_at).startsWith('2026-08-07T13'));
    db.appointments.push({ id: nextId('appt'), beautician_id: 'b1', client_id: 'x', starts_at: '2026-08-07T13:00:00Z', ends_at: '2026-08-07T15:00:00Z', status: 'confirmed' });
    const offer = await say('classic lashes today please');
    const offered = db.booking_conversations[0].offered.map(s => s.time);
    if (!(offered.includes('15:00') && offered.includes('15:30'))) return; // diary did not produce the pair
    await say('the 3 one');
    expect(db.appointments.filter(a => a.booked_via === 'ai_front_desk')).toHaveLength(0);
  });
});

/**
 * The dial is not enough, and this is the evidence.
 *
 * Every string below is a REAL message from Ellie's inbox, with the intent and
 * confidence the live classifier actually gave it. The fragments are not
 * hypothetical: at 0.85 they clear the autonomy dial, and without a second
 * check Florrie would open a booking negotiation on somebody saying thank you
 * and auto-send "is it Classic Lash Extensions or Lash Lift?" into it.
 */
describe('a confident label is not evidence that somebody wants to book', () => {
  const REAL_FRAGMENTS = [
    ['Amazing!x', 'booking_request', 0.95],
    ["Yes that's perfect thank you!xx", 'booking_request', 0.85],
    ['If that works? X', 'booking_request', 0.85],
    ['Round about 515 xx', 'availability_check', 0.85],
    ['Perfect xx', 'booking_request', 0.75],
    ['15th love x', 'booking_request', 0.65],
  ];

  for (const [text, intent, conf] of REAL_FRAGMENTS) {
    it(`does not start a booking on "${text}" (${intent} at ${conf})`, async () => {
      freezeSalonClock();
      const r = await advanceBookingConversation({
        beautician: BEAUTICIAN, client: CLIENT, message: text,
        classification: { intent, confidence: conf },
        context: { treatments: TREATMENTS, treatmentsError: null, patchTest: null },
      });
      expect(r, `"${text}" opened a booking conversation`).toBeNull();
      expect(db.booking_conversations).toHaveLength(0);
    });
  }

  const REAL_ENQUIRIES = [
    ['Can i book in thursday 5pm', 'booking_request', 0.95],
    ['hiya do you do lash lifts', 'booking_request', 0.9],
    ['hey do you have any appointments this week?', 'booking_request', 0.9],
    ['any chance you could squeeze me in friday', 'booking_request', 0.9],
    // Names something on her menu with no booking word at all.
    ['Oh and brow lamination', 'booking_request', 0.85],
  ];

  for (const [text, intent, conf] of REAL_ENQUIRIES) {
    it(`still opens on "${text}"`, async () => {
      freezeSalonClock();
      const r = await advanceBookingConversation({
        beautician: BEAUTICIAN, client: CLIENT, message: text,
        classification: { intent, confidence: conf },
        context: { treatments: TREATMENTS, treatmentsError: null, patchTest: null },
      });
      expect(r, `"${text}" was ignored and should not have been`).not.toBeNull();
    });
  }

  // A question about a booking they already have is not a request for a new one.
  it('does not start a booking on "What time is my appointment on Friday please"', async () => {
    freezeSalonClock();
    const r = await advanceBookingConversation({
      beautician: BEAUTICIAN, client: CLIENT,
      message: 'Hi lovely. What time is my appointment on Friday please?',
      classification: { intent: 'availability_check', confidence: 0.95 },
      context: { treatments: TREATMENTS, treatmentsError: null, patchTest: null },
    });
    expect(r).toBeNull();
  });

  // Once an offer is on the table a fragment IS the answer, so the gate must
  // not apply to a conversation already under way.
  it('still accepts "the 4 one" mid-conversation, which is a fragment by design', async () => {
    freezeSalonClock();
    await say('classic lashes today please');
    const r = await say('the 4 one');
    expect(r).not.toBeNull();
    expect(db.appointments.filter(a => a.booked_via === 'ai_front_desk')).toHaveLength(1);
  });
});

/**
 * The one parameter I could not test against the real Stripe.
 *
 * Their documented range is 30 minutes to 24 hours from creation, judged on
 * their clock when the request lands. Ours sits just inside the bottom of that,
 * on purpose, so the deposit link dies with the hold. Both ends are asserted
 * because "at least 30 minutes" and "at most 24 hours" are equally able to
 * reject the session, and a rejected session means no deposit link at all.
 */
describe('the deposit link expiry', () => {
  it('sits inside the range Stripe documents', async () => {
    freezeSalonClock();
    await say('classic lashes today please');
    await say('the 4 one');
    const s = stripeCalls.sessions[0];
    const seconds = s.expires_at - Math.floor(Date.now() / 1000);
    expect(seconds).toBeGreaterThan(30 * 60);
    expect(seconds).toBeLessThan(24 * 60 * 60);
  });

  it('asks again with more room if Stripe refuses, and the hold follows', async () => {
    freezeSalonClock();
    refuseExpiryOnce.value = true;
    await say('classic lashes today please');
    const r = await say('the 4 one');

    expect(stripeCalls.sessions).toHaveLength(2);
    expect(stripeCalls.sessions[1].expires_at).toBeGreaterThan(stripeCalls.sessions[0].expires_at);
    expect(r.reply).toContain('https://checkout.stripe.com/');

    // The link must never outlive the hold, so the hold moved with it.
    const appt = db.appointments.find(a => a.booked_via === 'ai_front_desk');
    expect(new Date(appt.payment_expires_at).getTime() / 1000)
      .toBeGreaterThanOrEqual(stripeCalls.sessions[1].expires_at);
  });
});
