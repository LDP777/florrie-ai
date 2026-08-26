/**
 * SOPHIE'S CONFIRMATION HAD NO LINK IN IT, AND NOTHING ANYWHERE KNEW.
 *
 * 26 August 2026, the WhatsApp thread:
 *
 *   out  "Hi Sophie! It's Ellindigo 🌸 Your appointment is confirmed for
 *         Thu 3 Sept at 12:00. Reply here if anything needs changing.
 *         See you then!"
 *   in   "Hey, I can't see a link in the confirmation. Should it come through
 *         text or email? X"
 *
 * She was right. A Meta-approved template body cannot carry a url, so the link
 * travels in a SECOND WhatsApp message on generic_message_v2, the only
 * template in the registry with a free-text slot. That second send existed,
 * under a long comment explaining why it was essential and naming Lucy Walker,
 * who on 21 August was told to use a link she had never received.
 *
 * It has never been delivered. Not once, in fourteen days of confirmations.
 * And it was invisible for one reason: its result was never read.
 *
 *     await sendWhatsApp({ ... templateName: 'generic_message_v2' ... });
 *
 * Nothing on the left of the await. sendWhatsApp returns null on a quota
 * block, a missing token, a missing phone_number_id, a PECR block, and on
 * anything Meta rejects. A template Meta has been refusing for a fortnight
 * therefore looked exactly like a template Meta was accepting.
 *
 * WHAT THIS FILE ASSERTS, and it is one sentence:
 *
 *   when the WhatsApp link follow-up fails, the client still gets the link.
 *
 * Deliberately not "the return value is read". Reading it and then logging is
 * the same outcome for Sophie as not reading it at all. So the whole send path
 * runs for real here, down to the HTTP calls, and every assertion is about
 * what actually left the building: what was POSTed to Meta, what was POSTed to
 * Bird, and what a human can find afterwards.
 */
process.env.TZ = 'UTC';

import { describe, it, expect, beforeEach, vi } from 'vitest';

process.env.FRONTEND_URL = 'https://florrie.ai';
process.env.PUBLIC_API_URL = 'https://api.florrie.ai';
// Module-scope consts in notifications.js, so they must exist before import.
process.env.BIRD_API_KEY = 'test-bird-key';
process.env.WHATSAPP_TOKEN = 'test-token';
process.env.WHATSAPP_WABA_ID = 'waba_env';

/* ------------------------------------------------------------------ schema --
 * Columns copied from supabase/migrations for the table this change WRITES a
 * new shape into. ai_actions is 001_initial_schema.sql; action_type lost its
 * CHECK in 051 and outcome kept its one:
 *
 *   outcome TEXT CHECK (outcome IN ('success','pending','failed','escalated'))
 *
 * That constraint is not decoration here. logSendFailure has always written
 * outcome:'failure', which is not in the list, so PostgREST rejected the row
 * with 23514 and the catch around it turned that into a logger.warn. The one
 * place a permanent send failure was meant to become visible to a human has
 * been silently discarding every one of them, on every channel, for as long as
 * it has existed. That is the largest single reason a dead template could run
 * for a fortnight with nobody knowing, so the mock enforces the constraint.
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

let idCounter = 0;
function builder(table) {
  const filters = [];
  let pending = null;
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
    if (pending?.op === 'update') {
      const matched = rows();
      for (const r of matched) Object.assign(r, pending.payload);
      return { data: matched, error: null };
    }
    return { data: rows(), error: null, count: rows().length };
  };
  const b = {
    select() { return b; },
    insert(p) { if (table === 'ai_actions') err = err || checkAiAction(p); pending = { op: 'insert', payload: p }; return b; },
    update(p) { pending = { op: 'update', payload: p }; return b; },
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

// Metering is not what is under test, and the real thing would need three more
// tables. The quota gate is pinned OPEN on purpose: it is the gate the FIRST
// message already proved is open, because that message arrived.
vi.mock('../../src/services/whatsapp-metering.js', () => ({
  checkWhatsAppQuota: async () => ({ allowed: true, isOverage: false }),
  trackWhatsAppMessage: async () => true,
  trackSmsInMonthlyQuota: async () => true,
  getMonthlyUsage: async () => null,
}));
vi.mock('../../src/services/sms-metering.js', () => ({ trackSMSUsage: async () => null }));
// No Twilio tenant here: every assertion is about the Meta path Ellie is on.
vi.mock('../../src/services/whatsapp-twilio.js', () => ({
  twilioConfigured: () => false,
  twilioSendText: async () => null,
  twilioSendTemplate: async () => null,
  twilioContentSid: () => null,
}));
vi.mock('@sentry/node', () => ({ captureMessage: () => {}, captureException: () => {} }));

/* --------------------------------------------------------------- the wires --
 * One fetch mock standing in for Meta, Bird and Resend, recording everything
 * that leaves. `wa.linkTemplateOk` and `bird.ok` are the two switches every
 * scenario in this file turns.
 */
const sent = { meta: [], bird: [], resend: [] };
const wa = { linkTemplateOk: false, confirmationOk: true };
const bird = { ok: true };

const PHONE_ID = 'phone_1';
const WABA_ID = 'waba_1';

// booking_confirmation_v2 is approved on this WABA. generic_message is not, in
// ANY version, which is what Meta error 132001 means and what the pilot's
// /template-debug endpoint exists to diagnose.
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
    sent.bird.push(body);
    return jsonRes(200, { id: `bird_${sent.bird.length}` });
  }

  if (u.includes('api.resend.com')) {
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
    const name = body?.template?.name || '';
    const isLink = name.startsWith('generic_message');
    const ok = isLink ? wa.linkTemplateOk : wa.confirmationOk;
    if (!ok) {
      // Exactly what Meta answers for a template that is not approved on the
      // WABA the sending number is parented to.
      return jsonRes(404, {
        error: {
          code: 132001,
          message: 'Template name does not exist in the translation',
          error_data: { details: `template name (${name}) does not exist in en_GB` },
        },
      });
    }
    sent.meta.push(body);
    return jsonRes(200, { messages: [{ id: `wamid_${sent.meta.length}` }] });
  }

  throw new Error(`unexpected fetch: ${u}`);
});

const { notifyBookingConfirmed } = await import('../../src/services/notifications.js');

/* ------------------------------------------------------------------ world -- */
const MANAGE_TOKEN = 'tok_sophie';
const CALENDAR_URL = `https://api.florrie.ai/api/booking/ellindigo/manage/${MANAGE_TOKEN}/calendar`;

function seed({ prefs = {}, phone = '+447700900123', email = null } = {}) {
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
    // starts_at is salon WALL TIME parked in a UTC slot. Thu 3 Sept, 12:00.
    starts_at: '2026-09-03T12:00:00.000Z',
    ends_at: '2026-09-03T13:00:00.000Z',
    management_token: MANAGE_TOKEN, price_cents: 4500, reschedule_count: 0,
    clients: { first_name: 'Sophie', phone, email },
    treatments: { name: 'Brow Lamination', duration_minutes: 60 },
    beauticians: {
      business_name: 'Ellindigo', first_name: 'Ellie', booking_slug: 'ellindigo',
      client_reminder_prefs: { channel: 'whatsapp', ...prefs },
      brand_color: '#C4A882', tagline: null, logo_url: null,
    },
  });
}

/** Every WhatsApp template Meta actually accepted, by name. */
const metaTemplatesSent = () => sent.meta.map(m => m?.template?.name);
/** Every SMS body Bird actually accepted. */
const smsBodies = () => sent.bird.map(m => m?.body?.text?.text || '');
/** Everything that reached Sophie's phone, on any channel. */
const everythingSheGot = () => [
  ...sent.meta.map(m => (m?.template?.components?.[0]?.parameters || []).map(p => p.text).join(' ')),
  ...smsBodies(),
];

beforeEach(() => {
  for (const t of Object.keys(db)) db[t] = [];
  sent.meta.length = 0; sent.bird.length = 0; sent.resend.length = 0;
  for (const k of Object.keys(logs)) logs[k].length = 0;
  wa.linkTemplateOk = false;
  wa.confirmationOk = true;
  bird.ok = true;
});

/* ======================================================== THE LOAD-BEARING == */
describe('when the WhatsApp link follow-up fails', () => {
  it('SOPHIE STILL GETS THE LINK', async () => {
    seed();

    const result = await notifyBookingConfirmed('a1');

    // The confirmation itself went, exactly as it did in production.
    expect(metaTemplatesSent()).toContain('booking_confirmation_v2');
    // The link template was refused, exactly as it was in production.
    expect(metaTemplatesSent()).not.toContain('generic_message_v2');

    // And this is the whole point of the change: something carrying the link
    // reached her anyway. Not a log line, not a return value. A message.
    const withLink = everythingSheGot().filter(t => t.includes(`/manage/${MANAGE_TOKEN}`));
    expect(withLink.length, 'nothing carrying the booking link reached the client').toBeGreaterThan(0);

    expect(result.sent).toBe(true);
    expect(result.link).toMatchObject({ channel: 'sms' });
  });

  it('sends her the calendar link by text, in words that say what it does', async () => {
    seed();
    await notifyBookingConfirmed('a1');

    expect(smsBodies()).toHaveLength(1);
    const body = smsBodies()[0];
    expect(body).toContain(CALENDAR_URL);
    expect(body).toContain('Sophie');
    expect(body).toContain('Ellindigo');
    // House rule: no em or en dashes in anything a human reads.
    expect(body).not.toMatch(/[–—]/);
  });

  it('reports the text on the confirmation, rather than pretending only WhatsApp went', async () => {
    seed();
    const result = await notifyBookingConfirmed('a1');
    expect(result.channels).toContain('whatsapp');
    expect(result.channels).toContain('sms');
  });

  it('routes the fallback through the outbound guard, typed transactional', async () => {
    seed();
    await notifyBookingConfirmed('a1');

    const row = db.outbound_sends.find(r => r.message_type === 'booking_confirmation');
    expect(row, 'the SMS fallback did not go through the guarded machinery').toBeTruthy();
    // Not marketing. A client's own booking link is a service message, and a
    // proactive classification would hand it to the quiet-hours gate that this
    // link has already been binned by once.
    expect(row.tier).toBe('transactional');
    expect(row.status).toBe('sent');
    expect(row.channel).toBe('sms');
  });

  it('leaves the failed WhatsApp template where a human can find it', async () => {
    seed();
    await notifyBookingConfirmed('a1');

    // logSendFailure has always tried to write this row and PostgREST has
    // always rejected it: outcome:'failure' against a CHECK that allows
    // 'failed'. Fourteen days of a dead template produced zero rows here.
    const failures = db.ai_actions.filter(a => a.action_type === 'send_failed');
    expect(failures.length, 'the send failure was never recorded anywhere a person looks').toBeGreaterThan(0);
    expect(failures.every(f => AI_ACTION_OUTCOMES.includes(f.outcome))).toBe(true);
  });
});

/* ================================================= when NOTHING can be sent == */
describe('when neither channel can carry the link', () => {
  beforeEach(() => { bird.ok = false; });

  it('says so at error level, naming the client and the reason', async () => {
    seed();
    const result = await notifyBookingConfirmed('a1');

    expect(result.link).toMatchObject({ channel: null });
    expect(result.link.reason).toBeTruthy();

    const shouted = logs.error.some(([ctx, msg]) =>
      /link not delivered on any channel/i.test(String(msg)) && ctx?.appointmentId === 'a1');
    expect(shouted, 'a client with an unusable confirmation did not produce an error log').toBe(true);
  });

  it('records the outcome where an operator can see it', async () => {
    seed();
    await notifyBookingConfirmed('a1');

    const row = db.ai_actions.find(a => a.action_type === 'booking_link_not_delivered');
    expect(row, 'nothing an operator can read says this client cannot manage her booking').toBeTruthy();
    expect(row.beautician_id).toBe('b1');
    expect(row.client_id).toBe('c1');
    expect(row.appointment_id).toBe('a1');
    // The row must be one the database will actually accept. This is the
    // constraint logSendFailure has been failing for its whole life.
    expect(AI_ACTION_OUTCOMES).toContain(row.outcome);
    expect(row.summary).toMatch(/link/i);
    expect(row.summary).not.toMatch(/[–—]/);
  });

  it('still tells the truth about the confirmation that DID go', async () => {
    seed();
    const result = await notifyBookingConfirmed('a1');
    // The template arrived. Saying otherwise would be the opposite lie.
    expect(result.sent).toBe(true);
    expect(result.channels).toEqual(['whatsapp']);
    expect(db.appointments[0].confirmation_sent_at).toBeTruthy();
  });
});

/* ============================================== when WhatsApp is working ==== */
describe('when the WhatsApp link follow-up works', () => {
  beforeEach(() => { wa.linkTemplateOk = true; });

  it('does not also text her, because that is two messages for one booking', async () => {
    seed();
    const result = await notifyBookingConfirmed('a1');

    expect(metaTemplatesSent()).toEqual(['booking_confirmation_v2', 'generic_message_v2']);
    expect(smsBodies()).toEqual([]);
    expect(result.link).toMatchObject({ channel: 'whatsapp' });
    expect(result.channels).toEqual(['whatsapp']);
  });

  it('puts the link in the second message, where a free-text body can hold it', async () => {
    seed();
    await notifyBookingConfirmed('a1');

    const link = sent.meta.find(m => m.template.name === 'generic_message_v2');
    const params = link.template.components[0].parameters.map(p => p.text);
    expect(params[0]).toBe('Sophie');
    expect(params[1]).toContain(CALENDAR_URL);
    expect(params[1]).not.toMatch(/[–—]/);
  });

  it('records nothing alarming', async () => {
    seed();
    await notifyBookingConfirmed('a1');
    expect(db.ai_actions.filter(a => a.action_type === 'booking_link_not_delivered')).toEqual([]);
  });
});

/* ===================================================== the surrounding cases = */
describe('the cases where there is no second message to send', () => {
  it('does not chase a link when the confirmation itself never went', async () => {
    // WhatsApp is dead for this tenant. The existing SMS fallback carries the
    // link inside the confirmation body, so a separate link message would be
    // the same link twice.
    wa.confirmationOk = false;
    seed();

    const result = await notifyBookingConfirmed('a1');

    expect(result.channels).toEqual(['sms']);
    expect(smsBodies()).toHaveLength(1);
    expect(smsBodies()[0]).toContain(`/manage/${MANAGE_TOKEN}`);
    // One text, not two.
    expect(result.link).toBeNull();
  });

  it('leaves the SMS-only path exactly as it was', async () => {
    seed({ prefs: { channel: 'sms' } });

    const result = await notifyBookingConfirmed('a1');

    expect(metaTemplatesSent()).toEqual([]);
    expect(smsBodies()).toHaveLength(1);
    expect(smsBodies()[0]).toContain(`/manage/${MANAGE_TOKEN}`);
    expect(result.link).toBeNull();
  });

  it('does not invent a link for a booking that has no manage token', async () => {
    seed();
    db.appointments[0].management_token = null;

    const result = await notifyBookingConfirmed('a1');

    expect(metaTemplatesSent()).toEqual(['booking_confirmation_v2']);
    expect(smsBodies()).toEqual([]);
    expect(result.link).toBeNull();
    // Not an error: there is genuinely nothing to send, and shouting about it
    // would train everyone to ignore the case where there is.
    expect(db.ai_actions.filter(a => a.action_type === 'booking_link_not_delivered')).toEqual([]);
  });
});
