/**
 * THE REMINDER NOBODY GOT, RECORDED AS THE REMINDER EVERYBODY GOT.
 *
 * 27 August 2026. reminder_24h_v2's approved body on the live WABA has TWO
 * slots, "Hi {{1}}, just a reminder that your appointment is tomorrow at
 * {{2}}.", and the send path had always passed three, the extra one being the
 * treatment name. Meta rejects a template send whose parameter count does not
 * match the approved body, every time, for every tenant, so no client had ever
 * received a 24-hour reminder on WhatsApp. Not one, in the whole life of the
 * feature.
 *
 * That was the outage. This file is about why it lasted.
 *
 * The reminder claims an appointment by INSERTing an ai_actions row before it
 * sends anything, and it has to: migration 065 puts a partial unique index on
 * (appointment_id) where action_type = 'appointment_reminder', so a concurrent
 * or restarted run hits 23505 and bails out instead of texting the client
 * twice. That ordering is correct and nothing here argues with it.
 *
 * The row said:
 *
 *     outcome: 'success',
 *     summary: `Sent ${first_name}'s 24-hour reminder`
 *
 * written before the send, and never corrected afterwards. So every one of
 * those rejections left behind a row asserting the send had succeeded. "What
 * Florrie did" is where a beautician looks to find out what went out on her
 * behalf. For a fortnight it told her, in her own client's name, that a
 * message Meta had refused had been sent. The audit trail did not merely miss
 * the outage: it stated the opposite of it, to the one person in a position to
 * notice.
 *
 * And the unique index made that permanent. A claim row exists, therefore the
 * appointment is done, therefore no later run will ever retry it. Every path
 * that ended without a delivery, a refused template, a client with no phone
 * and no email, and the patch-test TypeError below, spent the client's single
 * reminder and then filed a receipt for it.
 *
 * The patch test is worth naming on its own. A patch test carries no
 * treatment_id, so `treatments` comes back null. `treatmentName` was carefully
 * written as `treatment?.name || 'patch test'`, with a comment saying in
 * as many words that a crash here burns the client's only reminder. Twelve
 * lines below, the email body read `treatment.duration_minutes` with no
 * question mark, so every patch-test client with an email address threw a
 * TypeError after the claim row was written. The guard was added for the name
 * and not for the duration.
 *
 * WHAT THIS FILE ASSERTS, and it is one sentence:
 *
 *   when the reminder is over, the row says what actually happened.
 *
 * Delivered, refused, or thrown. Not "an update is issued", which is the same
 * outcome for Ellie as no update at all if it can carry a value the database
 * will not store. So the send path runs for real here, down to the HTTP calls,
 * every assertion is about the row a human would read afterwards, and the
 * Supabase fake enforces the CHECK on ai_actions.outcome the way Postgres
 * does, with a 23514, on updates as well as inserts. That constraint is not
 * decoration: logSendFailure spent its entire life writing outcome:'failure'
 * into a column that allows 'failed', and had every row rejected, which is the
 * largest single reason a dead template could run for a fortnight unnoticed.
 * tests/unit/ai-actions-values-are-legal.test.js greps the source for that
 * typo; this file makes the value fail at the point of writing, so the reminder
 * cannot reintroduce it behind a passing grep.
 */
process.env.TZ = 'UTC';

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

// Module-scope consts in notifications.js, so they must exist before import.
process.env.BIRD_API_KEY = 'test-bird-key';
process.env.RESEND_API_KEY = 'test-resend-key';
process.env.WHATSAPP_TOKEN = 'test-token';
process.env.WHATSAPP_WABA_ID = 'waba_env';

/* ------------------------------------------------------------------ schema --
 * ai_actions, from 001_initial_schema.sql, with the one CHECK that column
 * kept:
 *
 *   outcome TEXT CHECK (outcome IN ('success','pending','failed','escalated'))
 *
 * plus the partial unique index from 065_reminder_unique.sql, which is what
 * makes claim-then-send safe and also what makes a burnt claim permanent.
 * Note what the index is NOT keyed on: `outcome`. Claiming as 'pending'
 * dedupes exactly as well as claiming as 'success' did.
 */
const AI_ACTION_OUTCOMES = ['success', 'pending', 'failed', 'escalated'];
const AI_ACTION_COLUMNS = [
  'id', 'beautician_id', 'action_type', 'digital_employee', 'summary', 'details',
  'confidence', 'autonomous', 'client_id', 'appointment_id', 'message_id',
  'outcome', 'notification_sent', 'notification_text', 'created_at', 'status',
];

const db = {
  appointments: [], beauticians: [], clients: [], treatments: [], transactions: [],
  appointment_add_ons: [], messages: [], ai_actions: [], outbound_sends: [],
};

/**
 * Everything written to ai_actions, in order, insert and update alike, kept
 * separately from `db` because the row is REWRITTEN in the finally block and
 * the value it was claimed with would otherwise be unobservable by the time
 * the function returns.
 */
const aiActionWrites = [];

/**
 * The order things happened in, across the database and the wire. The whole
 * argument for claiming the row first is an ordering argument, so it is
 * asserted as one rather than inferred from what is left at the end.
 */
const timeline = [];

/** PostgREST's answer to a payload this table would refuse. */
function checkAiAction(payload) {
  for (const row of (Array.isArray(payload) ? payload : [payload])) {
    for (const col of Object.keys(row || {})) {
      if (!AI_ACTION_COLUMNS.includes(col)) {
        return { code: '42703', message: `column ai_actions.${col} does not exist` };
      }
    }
    if (row?.outcome != null && !AI_ACTION_OUTCOMES.includes(row.outcome)) {
      return { code: '23514', message: 'new row violates check constraint "ai_actions_outcome_check"' };
    }
  }
  return null;
}

/** 065: one reminder marker per appointment, ever. */
function checkReminderUnique(payload) {
  for (const row of (Array.isArray(payload) ? payload : [payload])) {
    if (row?.action_type !== 'appointment_reminder' || row?.appointment_id == null) continue;
    const clash = db.ai_actions.some(
      r => r.action_type === 'appointment_reminder' && r.appointment_id === row.appointment_id
    );
    if (clash) {
      return { code: '23505', message: 'duplicate key value violates unique constraint "ai_actions_one_reminder_per_appt"' };
    }
  }
  return null;
}

let idCounter = 0;
function builder(table) {
  const filters = [];
  let pending = null;
  let err = null;
  const rows = () => (db[table] || []).filter(r => filters.every(f => f(r)));
  const settle = () => {
    // PostgREST rejects the whole statement and resolves with an error rather
    // than throwing, which is why a bad column or a bad value shows up as a
    // silent no-op at the call site and not as a stack trace.
    if (err) return { data: null, error: err, count: null };
    if (pending?.op === 'insert') {
      const payload = Array.isArray(pending.payload) ? pending.payload : [pending.payload];
      const created = payload.map(p => ({ id: `${table}_${++idCounter}`, created_at: new Date().toISOString(), ...p }));
      db[table].push(...created);
      if (table === 'ai_actions') {
        for (const row of created) {
          aiActionWrites.push({ op: 'insert', payload: { ...row } });
          if (row.action_type === 'appointment_reminder') timeline.push(`claim:${row.outcome}`);
        }
      }
      return { data: created, error: null, count: created.length };
    }
    if (pending?.op === 'update') {
      const matched = rows();
      for (const r of matched) Object.assign(r, pending.payload);
      if (table === 'ai_actions') {
        aiActionWrites.push({ op: 'update', payload: { ...pending.payload } });
        for (const r of matched) {
          if (r.action_type === 'appointment_reminder') timeline.push(`settle:${r.outcome}`);
        }
      }
      return { data: matched, error: null };
    }
    return { data: rows(), error: null, count: rows().length };
  };
  const b = {
    select() { return b; },
    insert(p) {
      if (table === 'ai_actions') err = err || checkAiAction(p) || checkReminderUnique(p);
      pending = { op: 'insert', payload: p };
      return b;
    },
    // The CHECK applies to an UPDATE too, and this is the statement the fix
    // added. A correction that the database refuses is worth less than no
    // correction at all, because it leaves the claim standing and says nothing.
    update(p) {
      if (table === 'ai_actions') err = err || checkAiAction(p);
      pending = { op: 'update', payload: p };
      return b;
    },
    eq(c, v) { filters.push(r => r[c] === v); return b; },
    neq(c, v) { filters.push(r => r[c] !== v); return b; },
    in(c, v) { filters.push(r => v.includes(r[c])); return b; },
    is(c, v) { filters.push(r => (r[c] ?? null) === v); return b; },
    not() { return b; },
    or() { return b; },
    ilike(c, pattern) {
      const needle = String(pattern).replace(/%/g, '');
      filters.push(r => String(r[c] ?? '').toLowerCase().includes(needle.toLowerCase()));
      return b;
    },
    gte() { return b; }, lte() { return b; }, gt() { return b; }, lt() { return b; },
    order() { return b; }, limit() { return b; }, range() { return b; },
    maybeSingle() { const o = settle(); return Promise.resolve(o.error ? o : { data: (o.data || [])[0] || null, error: null }); },
    single() { const o = settle(); return Promise.resolve(o.error ? o : { data: (o.data || [])[0] || null, error: null }); },
    then(res, rej) { return Promise.resolve(settle()).then(res, rej); },
  };
  return b;
}

vi.mock('../../src/config.js', () => ({
  supabase: { from: builder },
  supabaseAdmin: { from: builder },
}));

const logs = { error: [], warn: [], info: [], debug: [] };
vi.mock('../../src/lib/logger.js', () => ({
  default: {
    error: (...a) => logs.error.push(a),
    warn: (...a) => logs.warn.push(a),
    info: (...a) => logs.info.push(a),
    debug: (...a) => logs.debug.push(a),
  },
}));

/**
 * The quota gate is pinned OPEN, because a quota block is not what this file
 * is about. `boom.metering` is the one lever that makes it throw, and it is
 * how the "a throw is recorded before it propagates" case is produced: the
 * quota check is the first thing sendWhatsApp does, it is not wrapped in a
 * try, and a metering table being unreachable mid-send is an ordinary Tuesday.
 */
const boom = { metering: null };
vi.mock('../../src/services/whatsapp-metering.js', () => ({
  checkWhatsAppQuota: async () => {
    if (boom.metering) throw new Error(boom.metering);
    return { allowed: true, isOverage: false };
  },
  trackWhatsAppMessage: async () => true,
  trackSmsInMonthlyQuota: async () => true,
  getMonthlyUsage: async () => null,
}));
vi.mock('../../src/services/sms-metering.js', () => ({ trackSMSUsage: async () => null }));
// No Twilio tenant here: the reminder that was refused was refused by Meta.
vi.mock('../../src/services/whatsapp-twilio.js', () => ({
  twilioConfigured: () => false,
  twilioSendText: async () => null,
  twilioSendTemplate: async () => null,
  twilioContentSid: () => null,
}));
vi.mock('@sentry/node', () => ({ captureMessage: () => {}, captureException: () => {} }));

/* --------------------------------------------------------------- the wires --
 * One fetch mock standing in for Meta, Bird and Resend, recording everything
 * that leaves.
 */
const sent = { meta: [], bird: [], resend: [] };
const wa = { reminderOk: true };
const bird = { ok: true };

const PHONE_ID = 'phone_1';
const WABA_ID = 'waba_1';

/**
 * What this WABA has approved, and only that.
 *
 * reminder_24h_v2 alone, deliberately. If _v4 were listed here the send path
 * would upgrade to it, _v4 declares four slots including the treatment name,
 * and the parameter-count assertion below would be measuring a template that
 * no tenant can currently send. Two slots is the shape Meta actually holds.
 */
const CATALOGUE = {
  data: [
    { name: 'booking_confirmation_v2', language: 'en_GB', status: 'APPROVED' },
    { name: 'reminder_24h_v2', language: 'en_GB', status: 'APPROVED' },
  ],
};

const jsonRes = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

global.fetch = vi.fn(async (url, opts = {}) => {
  const u = String(url);

  if (u.includes('api.bird.com')) {
    const body = JSON.parse(opts.body || '{}');
    if (!bird.ok) return jsonRes(422, { message: 'one or more fields are invalid' });
    timeline.push('bird:sms');
    sent.bird.push(body);
    return jsonRes(200, { id: `bird_${sent.bird.length}` });
  }

  if (u.includes('api.resend.com')) {
    timeline.push('resend:email');
    sent.resend.push(JSON.parse(opts.body || '{}'));
    return jsonRes(200, { id: 'resend_1' });
  }

  // Which WABA owns the sending phone.
  if (u.includes(`/${PHONE_ID}?fields=whatsapp_business_account`)) {
    return jsonRes(200, { whatsapp_business_account: { id: WABA_ID } });
  }
  // The approved-template catalogue for that WABA.
  if (u.includes('/message_templates')) return jsonRes(200, CATALOGUE);
  // The diagnostic sweep sendWhatsApp runs after a total failure.
  if (u.includes('/phone_numbers')) return jsonRes(200, { data: [{ id: PHONE_ID, display_phone_number: '+441234567890' }] });

  if (u.includes(`/${PHONE_ID}/messages`)) {
    const body = JSON.parse(opts.body || '{}');
    if (!wa.reminderOk) {
      // Verbatim shape of the rejection that ran in production for a fortnight.
      // 132000, not 132001: a parameter-count mismatch is not a locale problem,
      // so the send path stops rather than retrying the other languages.
      return jsonRes(400, {
        error: {
          code: 132000,
          message: 'Number of parameters does not match the expected number of parameters',
          error_data: { details: 'body: number of localizable_params (3) does not match the expected number of params (2)' },
        },
      });
    }
    timeline.push(`meta:${body?.template?.name}`);
    sent.meta.push(body);
    return jsonRes(200, { messages: [{ id: `wamid_${sent.meta.length}` }] });
  }

  throw new Error(`unexpected fetch: ${u}`);
});

const { notifyReminder24h } = await import('../../src/services/notifications.js');

/* ------------------------------------------------------------------ world -- */

/**
 * Only Date is faked.
 *
 * The clock matters because marketing quiet hours, the WABA catalogue cache
 * and the phone-to-WABA cache all read it, and a test that passes at 14:00 and
 * fails at 22:00 is not a test. It is pinned to the morning of the day the
 * outage was found.
 *
 * setTimeout is deliberately left real: sendSMS and sendEmail back off between
 * retries with it, and those retry paths are exactly the failure paths this
 * file exercises, so freezing the scheduler would hang the cases that matter
 * most. The cost is two real seconds in the one test where Bird refuses.
 */
vi.useFakeTimers({ toFake: ['Date'] });
vi.setSystemTime(new Date('2026-08-27T10:00:00.000Z'));
afterAll(() => { vi.useRealTimers(); });

/**
 * Sophie, reminded the day before. starts_at is salon WALL TIME parked in a
 * UTC slot, which is why the function reads it back with timeZone 'UTC' and
 * never with getHours(). Friday 28 August, 12:20.
 */
const APPT_TIME = '12:20';
const APPT_DATE = 'Friday 28 August';

function seed({ prefs = {}, phone = '+447700900123', email = null, treatments = { name: 'Korean Lash Lift', duration_minutes: 60 } } = {}) {
  db.beauticians.push({
    id: 'b1', business_name: 'Ellindigo', first_name: 'Ellie', booking_slug: 'ellindigo',
    whatsapp_phone_id: PHONE_ID, whatsapp_connected: true, wa_provider: 'meta',
    twilio_wa_sender: null, subscription_plan: 'pro', autonomy: {}, timezone: 'Europe/London',
    brand_color: '#C4A882', tagline: null, logo_url: null,
  });
  db.clients.push({
    id: 'c1', beautician_id: 'b1', first_name: 'Sophie', phone, email,
    marketing_consent: true, marketing_opted_out_at: null, messaging_autonomy: null,
  });
  db.appointments.push({
    id: 'a1', beautician_id: 'b1', client_id: 'c1', status: 'confirmed',
    starts_at: '2026-08-28T12:20:00.000Z',
    ends_at: '2026-08-28T13:20:00.000Z',
    duration_minutes: 20,
    treatment_id: treatments ? 't1' : null,
    clients: { first_name: 'Sophie', phone, email },
    treatments,
    beauticians: {
      business_name: 'Ellindigo', first_name: 'Ellie', booking_slug: 'ellindigo',
      whatsapp_phone_id: PHONE_ID,
      client_reminder_prefs: { channel: 'whatsapp', ...prefs },
      brand_color: '#C4A882', tagline: null, logo_url: null,
    },
  });
}

/** The claim, as it was written, before the finally block rewrote it. */
const claimAsWritten = () =>
  aiActionWrites.find(w => w.op === 'insert' && w.payload.action_type === 'appointment_reminder')?.payload;

/** The reminder row as a human would find it afterwards. */
const reminderRow = () => db.ai_actions.find(a => a.action_type === 'appointment_reminder');

/** Body parameters of a WhatsApp template Meta accepted. */
const paramsOf = (msg) => (msg?.template?.components?.[0]?.parameters || []).map(p => p.text);

beforeEach(() => {
  for (const t of Object.keys(db)) db[t] = [];
  sent.meta.length = 0; sent.bird.length = 0; sent.resend.length = 0;
  aiActionWrites.length = 0; timeline.length = 0;
  for (const k of Object.keys(logs)) logs[k].length = 0;
  wa.reminderOk = true;
  bird.ok = true;
  boom.metering = null;
});

/* ============================================== 1. the claim is not a boast = */
describe('the row claimed before anything is sent', () => {
  it('says it is sending, not that it has sent', async () => {
    seed();
    await notifyReminder24h('a1');

    const claim = claimAsWritten();
    expect(claim, 'no appointment_reminder row was ever claimed').toBeTruthy();
    expect(claim.outcome).toBe('pending');
    // The exact sentence Ellie was shown for a fortnight, about messages Meta
    // had refused, was "Sent Sophie's 24-hour reminder". A claim written before
    // the send cannot use the past tense of a verb that has not happened.
    expect(claim.summary).not.toMatch(/\bsent\b/i);
    expect(claim.summary).toBe("Sending Sophie's 24-hour reminder");
    expect(claim.summary).not.toMatch(/[\u2013\u2014]/);
  });

  it('is written before anything leaves, because that is what makes it a claim', async () => {
    seed();
    await notifyReminder24h('a1');

    // Insert-first is the dedupe (migration 065). Nothing may reach Meta, Bird
    // or Resend before the appointment has been claimed.
    expect(timeline[0]).toBe('claim:pending');
    expect(timeline.filter(e => e.startsWith('claim:'))).toHaveLength(1);
  });

  it('still refuses a second run, which is the whole reason for claiming first', async () => {
    seed();
    await notifyReminder24h('a1');
    const after = timeline.length;

    // 'pending' dedupes exactly as 'success' did: the unique index is on
    // (appointment_id) where action_type = 'appointment_reminder', and reads
    // no other column.
    await notifyReminder24h('a1');
    expect(db.ai_actions.filter(a => a.action_type === 'appointment_reminder')).toHaveLength(1);
    expect(timeline.slice(after)).toEqual([]);
  });
});

/* ======================================= 2. a reminder that reaches nobody == */
describe('a reminder that reaches nobody', () => {
  it('ends the row failed when there is no channel to try', async () => {
    seed({ phone: null, email: null });

    await notifyReminder24h('a1');

    expect(sent.meta).toEqual([]);
    expect(sent.bird).toEqual([]);
    expect(sent.resend).toEqual([]);

    const row = reminderRow();
    expect(row.outcome).toBe('failed');
    expect(row.summary).not.toMatch(/\bsent\b/i);
    expect(row.summary).toMatch(/could not send/i);
    expect(row.summary).toMatch(/no channel accepted it/i);
  });

  it('ends the row failed when Meta refuses the template and nothing else can carry it', async () => {
    // The exact production state, and the state that was invisible: the
    // template goes to Meta, Meta refuses it on parameter count, the SMS
    // fallback is refused by Bird, and this client has no email address. She
    // hears nothing at all about tomorrow's appointment.
    wa.reminderOk = false;
    bird.ok = false;
    seed({ email: null });

    await notifyReminder24h('a1');

    expect(sent.meta, 'Meta accepted a send it should have refused').toEqual([]);
    expect(sent.bird).toEqual([]);
    expect(sent.resend).toEqual([]);

    const row = reminderRow();
    expect(row.outcome, 'a reminder that reached nobody was still recorded as sent').toBe('failed');
    expect(row.summary).not.toMatch(/\bsent\b/i);
    expect(row.summary).toMatch(/could not send/i);
    expect(row.summary).toMatch(/Sophie/);
    // The claim was 'pending' and it did not stay that way. A row stuck on
    // 'pending' is the same silence as the old lie, only quieter.
    expect(timeline).toContain('settle:failed');
    expect(row.outcome).not.toBe('pending');
  });
});

/* ========================================== 3 and 7. a reminder that lands == */
describe('a reminder that lands', () => {
  it('ends the row success and names the channel that actually carried it', async () => {
    seed({ email: null });

    await notifyReminder24h('a1');

    expect(sent.meta).toHaveLength(1);

    const row = reminderRow();
    expect(row.outcome).toBe('success');
    expect(row.summary).toBe("Sent Sophie's 24-hour reminder by whatsapp");
    // Named, not implied. "Sent" alone was true of a row that was written
    // before the send and never checked.
    expect(row.summary).toMatch(/whatsapp/);
    expect(row.summary).not.toMatch(/sms|email/);
    expect(row.summary).not.toMatch(/[\u2013\u2014]/);
  });

  it('does not fall through to SMS once WhatsApp has taken it', async () => {
    seed({ email: null });
    await notifyReminder24h('a1');
    expect(sent.bird).toEqual([]);
  });

  it('sends reminder_24h_v2 with the two parameters its approved body has slots for', async () => {
    seed({ email: null });

    await notifyReminder24h('a1');

    const msg = sent.meta[0];
    expect(msg.template.name).toBe('reminder_24h_v2');

    const params = paramsOf(msg);
    // Three into two is the fault. The approved body is "Hi {{1}}, just a
    // reminder that your appointment is tomorrow at {{2}}." and has never had
    // a treatment slot, so a third parameter is not a cosmetic surplus: Meta
    // rejects the whole send and the client gets nothing.
    expect(params, `sent ${params.length} parameters into a two slot body`).toHaveLength(2);
    expect(params).toEqual(['Sophie', APPT_TIME]);
    // The treatment name travels as templateExtras, for the day _v4 is
    // approved and has somewhere to put it. It must not be a parameter here.
    expect(params).not.toContain('Korean Lash Lift');
    // Wall time read out of the UTC slot, not off the host clock.
    expect(params[1]).toBe(APPT_TIME);
  });
});

/* ============================== 4. a patch test, which has no treatment row = */
describe('a patch test, which carries no treatment_id', () => {
  it('sends the email instead of throwing, and marks the row success', async () => {
    // treatments is null because there is no treatment_id to join on. Before
    // the fix the email body read `treatment.duration_minutes` with no
    // optional chaining and threw a TypeError here, AFTER the claim row had
    // been written, so the client's one reminder was spent on an exception and
    // the unique index guaranteed no later run would retry it.
    seed({ treatments: null, phone: null, email: 'sophie@example.com' });

    await expect(notifyReminder24h('a1')).resolves.toBeUndefined();

    expect(sent.resend, 'the patch test client got no email').toHaveLength(1);
    const mail = sent.resend[0];
    expect(mail.to).toEqual(['sophie@example.com']);
    expect(mail.subject).toBe(`Reminder: patch test tomorrow at ${APPT_TIME}`);

    // Nothing in front of the client may read "undefined". A guard that turns
    // a crash into a message saying "undefined minutes" has moved the failure,
    // not fixed it.
    expect(mail.html).not.toContain('undefined');
    expect(mail.text).not.toContain('undefined');
    expect(mail.subject).not.toContain('undefined');

    // The duration falls back to the appointment's own, which a patch test has
    // even when it has no treatment row.
    expect(mail.html).toContain('20 minutes');
    expect(mail.html).toContain('patch test');
    expect(mail.html).toContain(`${APPT_DATE} at ${APPT_TIME}`);

    const row = reminderRow();
    expect(row.outcome).toBe('success');
    expect(row.summary).toBe("Sent Sophie's 24-hour reminder by email");
  });
});

/* ================================ 5. a throw is recorded before it escapes == */
describe('when the send half throws', () => {
  it('records the failure on the claimed row and then rethrows', async () => {
    boom.metering = 'metering backend unreachable';
    seed({ email: null });

    // Rethrown, so processReminders still logs it and the caller still knows.
    await expect(notifyReminder24h('a1')).rejects.toThrow('metering backend unreachable');

    const row = reminderRow();
    expect(row, 'the claim row vanished').toBeTruthy();
    // The three things it must not be. 'success' was the old behaviour and it
    // was a lie; 'pending' would be a claim nobody ever came back to.
    expect(row.outcome).not.toBe('success');
    expect(row.outcome).not.toBe('pending');
    expect(row.outcome).toBe('failed');
    expect(row.summary).toContain('metering backend unreachable');
    expect(row.summary).not.toMatch(/\bsent\b/i);
    // Written before the exception left the function, not by some later sweep.
    expect(timeline[timeline.length - 1]).toBe('settle:failed');
  });
});

/* ============================== 6. outcome is only ever a legal value ======= */
describe('the outcome column', () => {
  const scenarios = {
    'nothing to send': () => seed({ phone: null, email: null }),
    'Meta refuses': () => { wa.reminderOk = false; bird.ok = false; seed({ email: null }); },
    'WhatsApp accepts': () => seed({ email: null }),
    'email only': () => seed({ treatments: null, phone: null, email: 'sophie@example.com' }),
  };

  for (const [name, setup] of Object.entries(scenarios)) {
    it(`only ever receives a value the CHECK allows, ${name}`, async () => {
      setup();
      await notifyReminder24h('a1');

      // Every write, insert and update, including the ones logSendFailure makes
      // on the way past.
      expect(aiActionWrites.length).toBeGreaterThan(0);
      for (const w of aiActionWrites) {
        if (w.payload.outcome == null) continue;
        expect(AI_ACTION_OUTCOMES, `${w.op} wrote outcome:'${w.payload.outcome}'`).toContain(w.payload.outcome);
      }
      for (const row of db.ai_actions) {
        expect(AI_ACTION_OUTCOMES).toContain(row.outcome);
      }
    });
  }

  it('and the same is true of the run that throws', async () => {
    boom.metering = 'metering backend unreachable';
    seed({ email: null });
    await expect(notifyReminder24h('a1')).rejects.toThrow();

    for (const w of aiActionWrites) {
      if (w.payload.outcome == null) continue;
      expect(AI_ACTION_OUTCOMES).toContain(w.payload.outcome);
    }
  });

  /**
   * A constraint that cannot fail is indistinguishable from one that is not
   * there, and every assertion above would pass just as green against a fake
   * that stored anything handed to it. So prove the fake refuses, in both
   * statements, the way Postgres does: resolving with an error, not throwing,
   * because that is what let outcome:'failure' disappear into a catch for the
   * whole life of that table.
   */
  it('and the fake would really refuse anything else, on insert and on update', async () => {
    db.ai_actions.push({ id: 'x1', action_type: 'appointment_reminder', outcome: 'pending' });

    const badInsert = await builder('ai_actions').insert({
      beautician_id: 'b1', action_type: 'send_failed', outcome: 'failure',
    });
    expect(badInsert.data).toBeNull();
    expect(badInsert.error.code).toBe('23514');

    const badUpdate = await builder('ai_actions').update({ outcome: 'failure' }).eq('id', 'x1');
    expect(badUpdate.data).toBeNull();
    expect(badUpdate.error.code).toBe('23514');
    expect(db.ai_actions[0].outcome).toBe('pending');

    // And the whole select goes with one unknown column, rather than the
    // statement quietly succeeding without it.
    const badColumn = await builder('ai_actions').insert({ outcome: 'failed', reminded_at: 'now' });
    expect(badColumn.data).toBeNull();
    expect(badColumn.error.code).toBe('42703');

    // Legal values still land, so the refusals above are the constraint and
    // not a broken fake.
    const good = await builder('ai_actions').update({ outcome: 'failed' }).eq('id', 'x1');
    expect(good.error).toBeNull();
    expect(db.ai_actions[0].outcome).toBe('failed');
  });
});
