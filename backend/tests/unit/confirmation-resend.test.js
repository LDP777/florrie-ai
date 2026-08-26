/**
 * 26 AUGUST 2026. THE CONVERSATION THIS FILE REPLAYS.
 *
 *   14:48  in   client   "Hey Ellie, I'm unable to make this appointment next week..."
 *   14:50  out  human    "Hey Sophie, You are able to manage the appointment using the link..."
 *   14:52  in   client   "...don't think I got a confirmation. Do you know what the email is called?"
 *   14:53  out  ai       "Hey, i'll send you a new one now. should come through in a min xx"
 *   14:53  in   client   "Thanks"
 *
 * Nothing was sent. There was no code path that could have sent it.
 * notifyBookingConfirmed works and is called from Stripe, the booking flow,
 * routes/appointments.js and a Resend button in the app. It was never called
 * from services/ai-front-desk.js, and Florrie had no tools, so she described
 * the action instead of taking it. Sophie thanked her and waited for an email
 * that was never coming. Ellie asked: "How will I know if it actioned this?"
 *
 * THE CONTRACT THIS FILE ENFORCES, and it is one sentence:
 *
 *   either a real resend happened AND was logged, or nothing was claimed.
 *
 * That is deliberately not a test of the regex. The regex is what was scoped
 * too narrowly last time: lib/reply-claims-guard.js had ACTION_CLAIMS covering
 * moved / rescheduled / booked / sorted / changed, every one of them about a
 * booking change, and "I'll send you a new one now" walked straight through a
 * guard that existed precisely to stop Florrie narrating things nobody did.
 * So the model here is scripted to write THAT EXACT SENTENCE every time, and
 * every case asserts on what actually reached the client and what actually
 * reached ai_actions.
 */
process.env.TZ = 'UTC';

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { checkReplyClaims } from '../../src/lib/reply-claims-guard.js';

/* ------------------------------------------------------------------ schema --
 * Columns copied from supabase/migrations for the two tables this change
 * WRITES a new shape into. A wrong name is rejected by PostgREST for the whole
 * statement and the error is usually swallowed, which is how a logged action
 * becomes an unlogged one. Everything else passes through, so this file fails
 * for this defect and nothing else.
 *
 *   ai_actions      001_initial_schema.sql, plus `status` from
 *                   20260803_schema_drift_columns.sql. action_type lost its
 *                   CHECK in 051; outcome kept its one
 *                   (success | pending | failed | escalated).
 *   outbound_sends  066_outbound_guard.sql.
 */
const COLUMNS = {
  ai_actions: [
    'id', 'beautician_id', 'action_type', 'digital_employee', 'summary', 'details',
    'confidence', 'autonomous', 'client_id', 'appointment_id', 'message_id',
    'outcome', 'notification_sent', 'notification_text', 'created_at', 'status',
  ],
  outbound_sends: [
    'id', 'beautician_id', 'client_id', 'message_type', 'tier', 'channel',
    'status', 'reason', 'body', 'created_at', 'decided_at',
  ],
};
const OUTCOMES = ['success', 'pending', 'failed', 'escalated'];

const db = {
  beauticians: [], clients: [], appointments: [], messages: [], ai_actions: [],
  outbound_sends: [], treatments: [], patch_tests: [], client_intelligence: [],
};

const undefinedColumn = (table, col) => ({
  code: '42703', message: `column ${table}.${col} does not exist`, details: null, hint: null,
});

/** Split "a, b(c), d" on top-level commas only. */
function splitTop(spec) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of String(spec)) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map(s => s.trim()).filter(Boolean);
}

function checkSelect(table, spec) {
  const known = COLUMNS[table];
  if (!known || !spec || spec === '*') return null;
  for (const item of splitTop(spec)) {
    if (/^[\w]+\s*\(/.test(item)) continue;            // embedded resource
    const col = item.includes(':') ? item.split(':').pop().trim() : item;
    if (col === '*') continue;
    if (!known.includes(col)) return undefinedColumn(table, col);
  }
  return null;
}

function checkWrite(table, payload) {
  const known = COLUMNS[table];
  if (!known) return null;
  for (const row of (Array.isArray(payload) ? payload : [payload])) {
    for (const col of Object.keys(row || {})) {
      if (!known.includes(col)) return undefinedColumn(table, col);
    }
    // outcome kept its CHECK when action_type lost its one.
    if (table === 'ai_actions' && row?.outcome != null && !OUTCOMES.includes(row.outcome)) {
      return { code: '23514', message: 'new row violates check constraint "ai_actions_outcome_check"' };
    }
  }
  return null;
}

let idCounter = 0;
function builder(table) {
  const filters = [];
  let pending = null;
  let head = false;
  let err = null;
  const rows = () => (db[table] || []).filter(r => filters.every(f => f(r)));
  const settle = () => {
    if (err) return { data: null, error: err, count: null };
    if (pending?.op === 'insert') {
      const payload = Array.isArray(pending.payload) ? pending.payload : [pending.payload];
      const created = payload.map(p => ({ id: `${table}_${++idCounter}`, created_at: new Date().toISOString(), ...p }));
      db[table].push(...created);
      return { data: created, error: null, count: created.length };
    }
    if (pending?.op === 'update') { for (const r of rows()) Object.assign(r, pending.payload); return { data: rows(), error: null }; }
    if (head) return { data: null, error: null, count: rows().length };
    return { data: rows(), error: null, count: rows().length };
  };
  const b = {
    select(spec = '*', opts) { if (opts?.head) head = true; err = err || checkSelect(table, spec); return b; },
    insert(p) { err = err || checkWrite(table, p); pending = { op: 'insert', payload: p }; return b; },
    update(p) { err = err || checkWrite(table, p); pending = { op: 'update', payload: p }; return b; },
    eq(c, v) { filters.push(r => r[c] === v); return b; },
    neq(c, v) { filters.push(r => r[c] !== v); return b; },
    in(c, v) { filters.push(r => v.includes(r[c])); return b; },
    is(c, v) { filters.push(r => (r[c] ?? null) === v); return b; },
    not() { return b; },
    or() { return b; },
    gt(c, v) { filters.push(r => String(r[c] ?? '') > String(v)); return b; },
    gte(c, v) { filters.push(r => String(r[c] ?? '') >= String(v)); return b; },
    lt(c, v) { filters.push(r => String(r[c] ?? '') < String(v)); return b; },
    lte(c, v) { filters.push(r => String(r[c] ?? '') <= String(v)); return b; },
    order() { return b; },
    limit() { return b; },
    maybeSingle() { const o = settle(); return Promise.resolve(o.error ? o : { data: (o.data || [])[0] || null, error: null }); },
    single() { const o = settle(); return Promise.resolve(o.error ? o : { data: (o.data || [])[0] || null, error: null }); },
    then(res, rej) { return Promise.resolve(settle()).then(res, rej); },
  };
  return b;
}

vi.mock('../../src/config.js', () => ({ supabase: { from: builder } }));

/* -------------------------------------------------------------------- LLM --
 * Scripted, so the reply text is a constant of the experiment. `script.reply`
 * is the sentence Sophie was actually sent.
 */
const script = {
  classification: { intent: 'general_question', confidence: 0.95, extracted: {} },
  reply: "Hey, i'll send you a new one now. should come through in a min xx",
};
const promptsSeen = [];
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    constructor() {
      this.messages = {
        create: async ({ system }) => {
          if (/intent classifier/i.test(system)) {
            return { content: [{ text: JSON.stringify(script.classification) }] };
          }
          promptsSeen.push(system);
          return { content: [{ text: script.reply }] };
        },
      };
    }
  },
}));

/* ---------------------------------------------------------------- the send --
 * notifyBookingConfirmed is the REAL sender everywhere else in the app, so it
 * is the one thing stubbed here: what matters is that this file calls it, with
 * the right appointment, and reads its answer honestly. Note the failure shape
 * is an OBJECT, which is truthy, which is the trap.
 */
const confirmations = [];
let confirmResult = { sent: true, channels: ['email'] };
const delivered = [];
vi.mock('../../src/services/notifications.js', () => ({
  notifyBookingConfirmed: async (id) => { confirmations.push(id); return confirmResult; },
  sendMessage: async () => ({ channel: 'sms' }),
  sendInstagramDM: async () => true,
  sendWhatsAppText: async () => true,
  sendSMS: async (args) => { delivered.push(args); return { channel: 'sms' }; },
}));

vi.mock('../../src/services/push-notifications.js', () => ({
  pushEscalation: async () => true, pushTeamUpdate: async () => true,
}));
vi.mock('../../src/services/live-activity.js', () => ({ refreshLiveActivity: async () => true }));
vi.mock('../../src/services/automations.js', () => ({ createBookingSuggestion: async () => ({ id: 's1' }) }));
vi.mock('../../src/services/conversational-booking.js', () => ({ advanceBookingConversation: async () => null }));
vi.mock('../../src/services/loyalty.js', () => ({
  getLoyaltyConfig: async () => null, getClientPoints: async () => 0, loyaltyProximity: () => null,
}));
vi.mock('../../src/lib/promos.js', () => ({ getActivePromos: async () => [], describePromo: () => null }));
vi.mock('../../src/lib/knowledge.js', () => ({
  // One hit, so `general_question` is grounded and Florrie is allowed to speak.
  // Without this she is held for Ellie and the resend never gets its chance,
  // which is a real behaviour but not the one under test here.
  retrieveKnowledge: async () => [{ title: 'Confirmations', body: 'Confirmations arrive by email.' }],
  renderKnowledgeBlock: () => 'Knowledge: confirmations arrive by email.',
}));
vi.mock('../../src/lib/free-slots.js', () => ({ getFreeSlots: async () => [] }));

// The REAL outbound guard runs. Only its two outside dependencies are pinned so
// the test does not depend on what time of day it happens to run.
vi.mock('../../src/services/whatsapp-metering.js', () => ({ getMonthlyUsage: async () => null }));
vi.mock('../../src/lib/marketing-guard.js', () => ({ inMarketingQuietHours: () => false }));

process.env.ANTHROPIC_API_KEY = 'sk-test';

const { processInboundMessage, wantsConfirmationResent, pickConfirmationAppointment } =
  await import('../../src/services/ai-front-desk.js');
const { classifyTier } = await import('../../src/lib/outbound-guard.js');

/* ------------------------------------------------------------------ world -- */
const SOPHIE_ASKED = "...don't think I got a confirmation. Do you know what the email is called?";
const MSG_ID = 'msg_sophie_1452';

const iso = (daysFromNow, hhmm = '10:30') => {
  const d = new Date(Date.now() + daysFromNow * 86400000);
  return `${d.toISOString().slice(0, 10)}T${hhmm}:00.000Z`;
};

let beautician;
let client;

beforeEach(() => {
  for (const t of Object.keys(db)) db[t] = [];
  confirmations.length = 0;
  delivered.length = 0;
  promptsSeen.length = 0;
  confirmResult = { sent: true, channels: ['email'] };
  script.classification = { intent: 'general_question', confidence: 0.95, extracted: {} };
  script.reply = "Hey, i'll send you a new one now. should come through in a min xx";

  beautician = {
    id: 'b1', first_name: 'Ellie', business_name: 'Ell Indigo', booking_slug: 'ellindigo',
    confidence_threshold: 0.9, tone_model: {}, autonomy: {}, working_hours: null,
    timezone: 'Europe/London', client_reminder_prefs: {},
  };
  client = {
    id: 'c1', first_name: 'Sophie', phone: '+447700900123', preferred_channel: 'sms',
    messaging_autonomy: null, marketing_consent: true, marketing_opted_out_at: null,
  };
  db.beauticians.push(beautician);
  db.clients.push(client);
  db.messages.push({ id: MSG_ID, beautician_id: 'b1', client_id: 'c1', direction: 'inbound', content: SOPHIE_ASKED, created_at: new Date().toISOString() });
});

/** Sophie's next booking, a week out, the one she said she could not make. */
function nextWeekBooking(extra = {}) {
  const row = {
    id: 'appt_nextweek', beautician_id: 'b1', client_id: 'c1', status: 'confirmed',
    starts_at: iso(7, '10:30'), ends_at: iso(7, '11:30'),
    treatments: { name: 'Brow Lamination' }, ...extra,
  };
  db.appointments.push(row);
  return row;
}

const resendRows = () => db.ai_actions.filter(a => a.action_type === 'booking_confirmation_resent');
/** Everything that actually reached Sophie's phone. */
const textsToClient = () => delivered.map(d => d.body);
/** The draft left on the message for Ellie to approve. */
const draftOnMessage = () => db.messages.find(m => m.id === MSG_ID)?.ai_response || null;

/* =========================================================== the load test == */
describe('the 26 August conversation, replayed', () => {
  it('either really resends and logs it, or claims nothing', async () => {
    nextWeekBooking();

    await processInboundMessage(MSG_ID, beautician, client, SOPHIE_ASKED);

    const claimed = [...textsToClient(), draftOnMessage()]
      .filter(Boolean)
      .filter(t => !checkReplyClaims(t, { allowedTimes: [] }).ok);

    if (confirmations.length) {
      // A real send. Then it must be the right booking, and it must be on the
      // record, because "how will I know if it actioned this?" is the whole
      // point of the ai_actions row.
      expect(confirmations).toEqual(['appt_nextweek']);
      const row = resendRows()[0];
      expect(row).toBeTruthy();
      expect(row.outcome).toBe('success');
      expect(row.message_id).toBe(MSG_ID);
      expect(row.client_id).toBe('c1');
    } else {
      // No send. Then nothing anywhere may say there was one.
      expect(claimed).toEqual([]);
    }
  });

  it('sends the confirmation for real, on the real sender', async () => {
    nextWeekBooking();
    await processInboundMessage(MSG_ID, beautician, client, SOPHIE_ASKED);
    expect(confirmations).toEqual(['appt_nextweek']);
  });

  it('lets the sentence stand once it is true', async () => {
    nextWeekBooking();
    await processInboundMessage(MSG_ID, beautician, client, SOPHIE_ASKED);
    // The exact words Sophie got in production. They are no longer a lie, so
    // the guard must not swap them for a holding reply: that would be the
    // opposite failure, Florrie refusing to describe what she just did.
    expect(textsToClient().join(' ')).toMatch(/send|sent|come through/i);
  });

  it('logs the send where the owner can see it, against the message that claimed it', async () => {
    nextWeekBooking();
    await processInboundMessage(MSG_ID, beautician, client, SOPHIE_ASKED);

    const rows = resendRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      beautician_id: 'b1',
      client_id: 'c1',
      message_id: MSG_ID,
      appointment_id: 'appt_nextweek',
      digital_employee: 'front_desk',
      outcome: 'success',
    });
    expect(rows[0].summary).toMatch(/resent/i);
  });

  it('records the send through the outbound machinery, as transactional', async () => {
    nextWeekBooking();
    await processInboundMessage(MSG_ID, beautician, client, SOPHIE_ASKED);

    const row = db.outbound_sends.find(r => r.message_type === 'booking_confirmation');
    expect(row).toBeTruthy();
    expect(row.tier).toBe('transactional');
    expect(row.status).toBe('sent');
    // Not taken on trust: the guard's own list is the authority.
    expect(classifyTier('booking_confirmation')).toBe('transactional');
  });
});

/* ================================================== when it must not happen == */
describe('when the send fails', () => {
  beforeEach(() => { confirmResult = { sent: false, channels: [], reason: 'no_contact_details' }; });

  it('does not let the reply say it was sent', async () => {
    nextWeekBooking();
    await processInboundMessage(MSG_ID, beautician, client, SOPHIE_ASKED);

    for (const text of [...textsToClient(), draftOnMessage()].filter(Boolean)) {
      expect(checkReplyClaims(text, { allowedTimes: [] }).ok, text).toBe(true);
    }
  });

  it('logs the failure rather than swallowing it', async () => {
    nextWeekBooking();
    await processInboundMessage(MSG_ID, beautician, client, SOPHIE_ASKED);

    const rows = resendRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('failed');
    expect(rows[0].appointment_id).toBe('appt_nextweek');
    expect(rows[0].message_id).toBe(MSG_ID);
    expect(rows[0].summary).toMatch(/did not go/i);
    expect(rows[0].details.failure).toBe('no_contact_details');
  });

  it('puts it in front of Ellie', async () => {
    nextWeekBooking();
    await processInboundMessage(MSG_ID, beautician, client, SOPHIE_ASKED);
    const msg = db.messages.find(m => m.id === MSG_ID);
    expect(msg.escalated).toBe(true);
    expect(msg.escalated_reason).toMatch(/confirmation_resend/);
  });
});

describe('when there is nothing to resend', () => {
  it('does not guess, does not send, and hands it over', async () => {
    // No appointment rows at all.
    await processInboundMessage(MSG_ID, beautician, client, SOPHIE_ASKED);

    expect(confirmations).toEqual([]);
    const rows = resendRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('escalated');
    expect(rows[0].appointment_id).toBeNull();
    expect(rows[0].details.reason).toBe('no_upcoming_booking');
    for (const text of [...textsToClient(), draftOnMessage()].filter(Boolean)) {
      expect(checkReplyClaims(text, { allowedTimes: [] }).ok, text).toBe(true);
    }
  });
});

describe('when it is ambiguous', () => {
  it('refuses to pick when she names a different day', async () => {
    // Two live bookings. She names the Friday one; the next one is not Friday.
    const monday = new Date('2026-09-07T10:30:00.000Z');   // a Monday
    const friday = new Date('2026-09-11T10:30:00.000Z');   // that Friday
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T09:00:00.000Z'));
    db.appointments.push(
      { id: 'appt_mon', beautician_id: 'b1', client_id: 'c1', status: 'confirmed', starts_at: monday.toISOString(), ends_at: monday.toISOString(), treatments: { name: 'Brow Lamination' } },
      { id: 'appt_fri', beautician_id: 'b1', client_id: 'c1', status: 'confirmed', starts_at: friday.toISOString(), ends_at: friday.toISOString(), treatments: { name: 'Lash Lift' } },
    );

    await processInboundMessage(MSG_ID, beautician, client, "I never got the confirmation for Friday, can you resend it?");
    vi.useRealTimers();

    expect(confirmations).toEqual([]);
    expect(resendRows()[0].outcome).toBe('escalated');
    expect(resendRows()[0].details.reason).toBe('ambiguous_named_another_day');
  });
});

describe('when Florrie may not speak in this thread', () => {
  it('does not send either, and the draft claims nothing', async () => {
    // The standing rule, from the incident where a feature that WROTE sat
    // above the gate and put a real appointment in the diary for a client who
    // was never offered it.
    client.messaging_autonomy = 'just_me';
    db.clients[0].messaging_autonomy = 'just_me';
    nextWeekBooking();

    await processInboundMessage(MSG_ID, beautician, client, SOPHIE_ASKED);

    expect(confirmations).toEqual([]);
    expect(db.outbound_sends).toEqual([]);
    expect(resendRows()).toEqual([]);
    expect(textsToClient()).toEqual([]);
    const draft = draftOnMessage();
    expect(draft).toBeTruthy();
    expect(checkReplyClaims(draft, { allowedTimes: [] }).ok, draft).toBe(true);
  });
});

/* ======================================================== the two decisions == */
describe('reading the ask', () => {
  it.each([
    "...don't think I got a confirmation. Do you know what the email is called?",
    "I didn't get a confirmation email",
    "haven't received my booking confirmation",
    "can you resend the confirmation please",
    "no confirmation came through",
    "I can't find my confirmation anywhere",
  ])('hears %j', (m) => expect(wantsConfirmationResent(m)).toBe(true));

  it.each([
    'thanks for the confirmation lovely',
    'got my confirmation, see you Tuesday',
    "I'm unable to make this appointment next week",
    'how much is a lash lift?',
    "I never got the colour I wanted last time",
  ])('stays out of %j', (m) => expect(wantsConfirmationResent(m)).toBe(false));
});

describe('choosing the appointment', () => {
  const mon = { id: 'a1', starts_at: '2026-09-07T10:30:00.000Z', treatments: { name: 'Brow Lamination' } };
  const fri = { id: 'a2', starts_at: '2026-09-11T14:00:00.000Z', treatments: { name: 'Lash Lift' } };

  it('is the next one when there is only one', () => {
    expect(pickConfirmationAppointment([mon], 'no confirmation').appointment.id).toBe('a1');
  });

  it('is the next one when the conversation does not say otherwise', () => {
    const v = pickConfirmationAppointment([fri, mon], 'no confirmation');
    expect(v.appointment.id).toBe('a1');
    expect(v.reason).toBe('next_upcoming_booking');
  });

  it('refuses when she names another day', () => {
    expect(pickConfirmationAppointment([mon, fri], 'no confirmation for Friday').appointment).toBeNull();
  });

  it('refuses when she names another treatment', () => {
    expect(pickConfirmationAppointment([mon, fri], 'no confirmation for my lash lift').appointment).toBeNull();
  });

  it('is happy when the day she names IS the next one', () => {
    expect(pickConfirmationAppointment([mon, fri], 'no confirmation for Monday').appointment.id).toBe('a1');
  });

  it('refuses when there is nothing booked', () => {
    const v = pickConfirmationAppointment([], 'no confirmation');
    expect(v.appointment).toBeNull();
    expect(v.reason).toBe('no_upcoming_booking');
  });

  // starts_at is salon WALL TIME parked in the UTC slot. Reading the weekday
  // through a local conversion moves it by an hour in BST, which at 00:30 is a
  // different day and a different appointment.
  it('reads the weekday in wall time, not local time', () => {
    const lateSunday = { id: 'a3', starts_at: '2026-09-06T23:30:00.000Z', treatments: { name: 'Pedicure' } };
    const v = pickConfirmationAppointment([lateSunday, fri], 'no confirmation for Sunday');
    expect(v.appointment.id).toBe('a3');
  });
});
