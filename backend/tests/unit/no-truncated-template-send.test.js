/**
 * A MESSAGE WITH THE IMPORTANT HALF MISSING IS WORSE THAN NO MESSAGE.
 *
 * 27 August 2026. The registry claimed generic_message_v2 took
 * [first_name, message]; the body Meta approved is "Hi {{1}}, hope to see you
 * soon." and takes one. That is why Sophie's booking link never arrived: Meta
 * refuses a send whose parameter count does not match the approved body.
 *
 * The obvious repair is to correct the registry, and on its own it would have
 * made things WORSE. Shorten generic_message_v2 to [first_name] and the send
 * Meta was refusing becomes a send Meta ACCEPTS, with the url deleted from it.
 * Sophie gets a cheerful hello, sendBookingLink returns delivered:'whatsapp',
 * and the SMS fallback that actually reaches her never runs. The outage at
 * least had a fallback; a silent truncation has nothing.
 *
 * So the rule this file pins, and it is one sentence:
 *
 *   a send whose essential fields do not fit the body being sent does not
 *   happen at all, and says so where a human can find it.
 *
 * Assertions are about what left the building. Not a return value, not a log
 * line: what was POSTed to Meta, and what a person can read afterwards.
 */
process.env.TZ = 'UTC';

import { describe, it, expect, beforeEach, vi } from 'vitest';

process.env.WHATSAPP_TOKEN = 'test-token';
process.env.WHATSAPP_WABA_ID = 'waba_env';

const db = { beauticians: [], clients: [], ai_actions: [], messages: [] };

let idCounter = 0;
function builder(table) {
  const filters = [];
  let pending = null;
  const rows = () => (db[table] || []).filter((r) => filters.every((f) => f(r)));
  const settle = () => {
    if (pending?.op === 'insert') {
      const payload = Array.isArray(pending.payload) ? pending.payload : [pending.payload];
      const created = payload.map((p) => ({ id: `${table}_${++idCounter}`, created_at: new Date().toISOString(), ...p }));
      db[table].push(...created);
      return { data: created, error: null, count: created.length };
    }
    return { data: rows(), error: null, count: rows().length };
  };
  const b = {
    select() { return b; },
    insert(p) { pending = { op: 'insert', payload: p }; return b; },
    update(p) { pending = { op: 'update', payload: p }; return b; },
    eq(c, v) { filters.push((r) => r[c] === v); return b; },
    neq() { return b; }, in() { return b; }, is() { return b; }, not() { return b; }, or() { return b; },
    ilike(c, pattern) {
      const needle = String(pattern).replace(/%/g, '').toLowerCase();
      filters.push((r) => String(r[c] ?? '').toLowerCase().includes(needle));
      return b;
    },
    gte() { return b; }, lte() { return b; }, gt() { return b; }, lt() { return b; },
    order() { return b; }, limit() { return b; }, range() { return b; },
    maybeSingle() { const o = settle(); return Promise.resolve({ data: (o.data || [])[0] || null, error: null }); },
    single() { const o = settle(); return Promise.resolve({ data: (o.data || [])[0] || null, error: null }); },
    then(res, rej) { return Promise.resolve(settle()).then(res, rej); },
  };
  return b;
}

vi.mock('../../src/config.js', () => ({ supabase: { from: builder }, supabaseAdmin: { from: builder } }));

const logs = { error: [], warn: [], info: [], debug: [] };
vi.mock('../../src/lib/logger.js', () => ({
  default: {
    error: (...a) => logs.error.push(a),
    warn: (...a) => logs.warn.push(a),
    info: (...a) => logs.info.push(a),
    debug: (...a) => logs.debug.push(a),
  },
}));
vi.mock('../../src/services/whatsapp-metering.js', () => ({
  checkWhatsAppQuota: async () => ({ allowed: true, isOverage: false }),
  trackWhatsAppMessage: async () => true,
  trackSmsInMonthlyQuota: async () => true,
  getMonthlyUsage: async () => null,
}));
vi.mock('../../src/services/sms-metering.js', () => ({ trackSMSUsage: async () => null, shouldAutoSend: async () => ({ shouldSend: true }) }));
vi.mock('../../src/services/whatsapp-twilio.js', () => ({
  twilioConfigured: () => false,
  twilioSendText: async () => null,
  twilioSendTemplate: async () => null,
  twilioContentSid: () => null,
}));
vi.mock('@sentry/node', () => ({ captureMessage: () => {}, captureException: () => {} }));

const PHONE_ID = 'phone_1';
const WABA_ID = 'waba_1';

/* What this WABA has approved. Deliberately the state of the world ON the day:
 * the _v2 pack is live, the _v4 pack is still in review, so every caller falls
 * back to a v2 body and the v2 bodies are the short ones. */
const APPROVED = [
  { name: 'booking_confirmation_v2', language: 'en_GB', status: 'APPROVED' },
  { name: 'reminder_24h_v2', language: 'en_GB', status: 'APPROVED' },
  { name: 'generic_message_v2', language: 'en_GB', status: 'APPROVED' },
];

const posted = [];
const jsonRes = (status, body) => ({
  ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body),
});

global.fetch = vi.fn(async (url, opts = {}) => {
  const u = String(url);
  if (u.includes(`/${PHONE_ID}?fields=whatsapp_business_account`)) {
    return jsonRes(200, { whatsapp_business_account: { id: WABA_ID } });
  }
  if (u.includes('/message_templates')) return jsonRes(200, { data: APPROVED });
  if (u.includes('/phone_numbers')) return jsonRes(200, { data: [{ id: PHONE_ID, display_phone_number: '+441234567890' }] });
  if (u.includes(`/${PHONE_ID}/messages`)) {
    const body = JSON.parse(opts.body || '{}');
    posted.push(body);
    return jsonRes(200, { messages: [{ id: `wamid_${posted.length}` }] });
  }
  throw new Error(`unexpected fetch: ${u}`);
});

const { sendWhatsApp } = await import('../../src/services/notifications.js');
const { paramFieldsFor } = await import('../../src/lib/whatsapp-templates.js');

const LINK = 'https://api.florrie.ai/api/booking/ellindigo/manage/tok_sophie/calendar';
const PHONE = '+447700900123';

function seed() {
  db.beauticians.push({
    id: 'b1', business_name: 'Ellindigo', first_name: 'Ellie',
    whatsapp_phone_id: PHONE_ID, whatsapp_connected: true, wa_provider: 'meta', twilio_wa_sender: null,
  });
  db.clients.push({
    id: 'c1', beautician_id: 'b1', first_name: 'Sophie', phone: PHONE,
    marketing_consent: true, marketing_opted_out_at: null,
  });
}

const namesSent = () => posted.map((m) => m?.template?.name);
const paramsOf = (name) => (posted.find((m) => m?.template?.name === name)?.template?.components?.[0]?.parameters || [])
  .map((p) => p.text);

beforeEach(() => {
  for (const t of Object.keys(db)) db[t] = [];
  posted.length = 0;
  for (const k of Object.keys(logs)) logs[k].length = 0;
  seed();
});

/* ============================================================ the refusal == */
describe('a template with nowhere to put the message', () => {
  it('does not send a greeting with the booking link deleted from it', async () => {
    const result = await sendWhatsApp({
      to: PHONE,
      templateName: 'generic_message_v2',
      templateFields: { first_name: 'Sophie', message: `Change your booking here: ${LINK}` },
      beauticianId: 'b1',
      clientId: 'c1',
      transactional: true,
    });

    // Nothing at all reached Meta. Not a truncated send, not any send.
    expect(namesSent()).toEqual([]);
    // And null, which is what makes the caller take its SMS fallback.
    expect(result).toBeNull();
  });

  it('leaves the reason where a human can find it, in words about the message', async () => {
    await sendWhatsApp({
      to: PHONE,
      templateName: 'generic_message_v2',
      templateFields: { first_name: 'Sophie', message: `Change your booking here: ${LINK}` },
      beauticianId: 'b1',
      clientId: 'c1',
      transactional: true,
    });

    const row = db.ai_actions.find((a) => a.action_type === 'send_failed');
    expect(row, 'a refused send left no trace an operator could read').toBeTruthy();
    expect(row.outcome).toBe('failed');
    expect(row.details.detail).toMatch(/generic_message_v2/);
    expect(row.details.detail).toMatch(/message/);

    const shouted = logs.error.some(([, msg]) => /refused before it left/i.test(String(msg)));
    expect(shouted, 'the refusal was not logged at error level').toBe(true);
  });

  it('writes nothing into the thread either, because nothing was said', async () => {
    await sendWhatsApp({
      to: PHONE,
      templateName: 'generic_message_v2',
      templateFields: { first_name: 'Sophie', message: `Change your booking here: ${LINK}` },
      beauticianId: 'b1',
      clientId: 'c1',
      transactional: true,
    });
    expect(db.messages).toEqual([]);
  });

  it('refuses a positional array whose length disagrees with the registry', async () => {
    // The literal production call, byte for byte, before the fix: two params
    // into a one-slot body. The caller and the registry cannot both be right,
    // so neither is trusted.
    const result = await sendWhatsApp({
      to: PHONE,
      templateName: 'generic_message_v2',
      templateParams: ['Sophie', `Change your booking here: ${LINK}`],
      beauticianId: 'b1',
      clientId: 'c1',
      transactional: true,
    });
    expect(result).toBeNull();
    expect(namesSent()).toEqual([]);
    expect(db.ai_actions.find((a) => a.action_type === 'send_failed').details.detail)
      .toMatch(/takes 1 parameter/);
  });
});

/* ====================================================== what still goes out = */
describe('the sends that fit still go, unchanged', () => {
  it('sends the 24-hour reminder with the two parameters the body really has', async () => {
    const result = await sendWhatsApp({
      to: PHONE,
      templateName: 'reminder_24h_v2',
      templateParams: ['Sophie', '12:20'],
      // _v4 has a treatment slot and _v2 does not. Optional detail, so its
      // absence from the older body is not a refusal: that body never
      // promised to name her treatment.
      templateExtras: { treatment: 'Brow Lamination' },
      beauticianId: 'b1',
      clientId: 'c1',
    });

    expect(result).toBeTruthy();
    expect(namesSent()).toEqual(['reminder_24h_v2']);
    expect(paramsOf('reminder_24h_v2')).toEqual(['Sophie', '12:20']);
  });

  it('sends the confirmation exactly as before', async () => {
    const result = await sendWhatsApp({
      to: PHONE,
      templateName: 'booking_confirmation_v2',
      templateParams: ['Sophie', 'Thu 3 Sept', '12:00'],
      beauticianId: 'b1',
      clientId: 'c1',
    });
    expect(result).toBeTruthy();
    expect(paramsOf('booking_confirmation_v2')).toEqual(['Sophie', 'Thu 3 Sept', '12:00']);
  });

  it('never posts a parameter count the registry does not declare, whatever it is asked', async () => {
    // The invariant, swept across every send this file makes. If a future
    // change lets a mismatched count through, this is the assertion that
    // notices before Meta does.
    await sendWhatsApp({ to: PHONE, templateName: 'reminder_24h_v2', templateParams: ['Sophie', '12:20'], beauticianId: 'b1' });
    await sendWhatsApp({ to: PHONE, templateName: 'booking_confirmation_v2', templateParams: ['Sophie', 'Thu', '12:00'], beauticianId: 'b1' });
    await sendWhatsApp({ to: PHONE, templateName: 'rebook_nudge_v2', templateParams: ['Sophie'], beauticianId: 'b1' });
    await sendWhatsApp({ to: PHONE, templateName: 'generic_message_v2', templateFields: { first_name: 'Sophie', message: 'hello' }, beauticianId: 'b1', transactional: true });

    expect(posted.length).toBeGreaterThan(0);
    for (const m of posted) {
      const declared = paramFieldsFor(m.template.name);
      const sentCount = (m.template.components?.[0]?.parameters || []).length;
      expect(sentCount, `${m.template.name} was sent with the wrong parameter count`).toBe(declared.length);
    }
  });

  it('refuses rather than sending an empty parameter Meta would reject anyway', async () => {
    const result = await sendWhatsApp({
      to: PHONE,
      templateName: 'booking_confirmation_v2',
      templateParams: ['Sophie', '', '12:00'],
      beauticianId: 'b1',
    });
    expect(result).toBeNull();
    expect(namesSent()).toEqual([]);
  });
});
