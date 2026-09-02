/**
 * STOP MUST WORK WHETHER OR NOT THE OWNER HAS AUTO-REPLY SWITCHED ON.
 *
 * 2 September 2026. The only opt-out recogniser on WhatsApp (Meta and Twilio)
 * and SMS (Twilio and Bird) lived inside processInboundMessage, and every one
 * of those four handlers only called processInboundMessage inside
 * `if (beautician.auto_reply_enabled && ...)`. A salon with auto-reply off
 * stored 'STOP' as an ordinary message, marketing_opted_out_at stayed null,
 * and every rebook nudge, gap-fill offer and win-back kept going to a client
 * who had said no. PECR reg 22 does not have an auto-reply setting.
 *
 * Instagram was fixed on 31 August by hoisting the check above the mode
 * branch. These tests pin the same hoist on the other four handlers: at
 * source level (the recogniser sits above the auto-reply gate in each), and
 * behaviourally on the Bird handler, which has the cheapest harness.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = (rel) => readFileSync(join(here, '../../src', rel), 'utf8');

/** The handler body from its route registration to the next route or EOF. */
function handlerBody(source, routeLine) {
  const start = source.indexOf(routeLine);
  if (start < 0) throw new Error(`route not found: ${routeLine}`);
  const rest = source.slice(start + routeLine.length);
  const next = rest.search(/\nrouter\.(get|post)\(/);
  return next < 0 ? rest : rest.slice(0, next);
}

describe('the opt-out check sits above the auto-reply gate in every handler', () => {
  const cases = [
    ['routes/webhooks.js', "router.post('/whatsapp'", 'Meta WhatsApp'],
    ['routes/webhooks.js', "router.post('/twilio-sms'", 'Twilio SMS'],
    ['routes/webhooks.js', "router.post('/bird-sms'", 'Bird SMS'],
    ['routes/twilio-webhooks.js', "router.post('/whatsapp'", 'Twilio WhatsApp'],
  ];

  for (const [file, route, label] of cases) {
    it(`${label}: isOptOutMessage runs before auto_reply_enabled is consulted`, () => {
      const body = handlerBody(src(file), route);
      const optOutAt = body.indexOf('isOptOutMessage(');
      const gateAt = body.indexOf('auto_reply_enabled');
      expect(optOutAt, `${label} never calls isOptOutMessage`).toBeGreaterThan(-1);
      expect(gateAt, `${label} has no auto_reply_enabled gate`).toBeGreaterThan(-1);
      expect(optOutAt).toBeLessThan(gateAt);
      // The write and the confirmation, not just the recognition. Reading the
      // word and doing nothing with it is the bug in a different coat.
      expect(body).toContain('applyOptOut(');
      expect(body).toContain("messageType: 'marketing_opt_out'");
    });
  }
});

/* ------------------------------------------------------------- behaviour --
 * A small fake of the tables the Bird handler touches. Same shape as the
 * harness in sms-two-directions.test.js, trimmed to what STOP needs.
 */
const state = { beauticians: [], clients: [], messages: [], ai_actions: [] };
let ids = 0;

function makeBuilder(table) {
  const filters = [];
  let pending = null;
  let limit = Infinity;
  const rows = () => (state[table] || []).filter(r => filters.every(f => f(r)));
  const settle = () => {
    if (pending?.op === 'update') {
      const hit = rows();
      for (const r of hit) Object.assign(r, pending.payload);
      return { data: hit, error: null };
    }
    if (pending?.op === 'insert') {
      const payload = Array.isArray(pending.payload) ? pending.payload : [pending.payload];
      const created = payload.map(p => ({ id: `${table}_${++ids}`, ...p }));
      (state[table] ||= []).push(...created);
      return { data: created, error: null };
    }
    return { data: rows().slice(0, limit), error: null };
  };
  const b = {
    select() { return b; },
    insert(p) { pending = { op: 'insert', payload: p }; return b; },
    update(p) { pending = { op: 'update', payload: p }; return b; },
    eq(c, v) { filters.push(r => r[c] === v); return b; },
    neq(c, v) { filters.push(r => r[c] !== v); return b; },
    is(c, v) { filters.push(r => (r[c] ?? null) === v); return b; },
    in(c, v) { filters.push(r => v.includes(r[c])); return b; },
    or() { return b; },
    ilike() { return b; },
    order() { return b; },
    limit(n) { limit = n; return b; },
    maybeSingle() { const o = settle(); return Promise.resolve({ data: (o.data || [])[0] || null, error: null }); },
    single() { const o = settle(); return Promise.resolve({ data: (o.data || [])[0] || null, error: null }); },
    then(res, rej) { return Promise.resolve(settle()).then(res, rej); },
  };
  return b;
}

vi.mock('../../src/config.js', () => ({
  supabase: { from: (t) => makeBuilder(t) },
  supabaseAnon: { from: (t) => makeBuilder(t) },
}));

const logged = { error: [], warn: [], info: [] };
vi.mock('../../src/lib/logger.js', () => {
  const rec = (level) => (a, b) => { logged[level]?.push({ ctx: typeof a === 'object' ? a : {}, msg: typeof a === 'string' ? a : b }); };
  return { default: { error: rec('error'), warn: rec('warn'), info: rec('info'), debug: () => {} } };
});

const frontDesk = { calls: [] };
vi.mock('../../src/services/ai-front-desk.js', () => ({
  processInboundMessage: async (...args) => { frontDesk.calls.push(args); return { handled: true, intent: 'other' }; },
}));

/** Every guarded send, so the test can see the confirmation and its type. */
const guarded = [];
vi.mock('../../src/lib/outbound-guard.js', () => ({
  guardedSend: async (args) => {
    guarded.push(args);
    const ok = await args.send();
    return { decision: 'send', tier: 'transactional', reason: 'ok', delivered: !!ok, deliveryId: null };
  },
}));

const smsSent = [];
vi.mock('../../src/services/notifications.js', () => ({
  isSharedSmsNumber: () => false,
  sendSMS: async (args) => { smsSent.push(args); return 'sms_1'; },
  sendWhatsAppText: async () => 'wa_1',
}));

vi.mock('../../src/services/delivery-receipts.js', () => ({ applyWhatsAppStatuses: async () => true }));
vi.mock('../../src/services/push-notifications.js', () => ({ pushMessagesWaiting: async () => true }));
vi.mock('../../src/lib/client-archive.js', () => ({ autoUnarchiveClient: async () => true }));
vi.mock('../../src/middleware/auth.js', () => ({ requireAuth: (_q, _s, next) => next() }));
vi.mock('../../src/lib/schema-probe.js', () => ({ hasColumn: async () => true, __resetSchemaProbeCache: () => {} }));
vi.mock('@anthropic-ai/sdk', () => ({ default: class { constructor() { this.messages = { create: async () => ({ content: [] }) }; } } }));

process.env.BIRD_WEBHOOK_TOKEN = 'test-bird-webhook-token';

const webhooksRouter = (await import('../../src/routes/webhooks.js')).default;

async function run(router, method, path, req) {
  const layer = router.stack.find(l => l.route?.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`no ${method} ${path}`);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const res = { status() { return res; }, json() { return res; }, sendStatus() { return res; }, type() { return res; }, send() { return res; } };
  await handler({ headers: {}, query: {}, body: {}, params: {}, ...req }, res);
}

const inboundSms = (to, from, body) =>
  run(webhooksRouter, 'post', '/bird-sms', {
    headers: { 'x-webhook-token': process.env.BIRD_WEBHOOK_TOKEN },
    body: { originator: from, recipient: to, payload: body, id: `ext_${++ids}` },
  });

const HER_NUMBER = '+447700900123';
const CLIENT = '+447900000001';

beforeEach(() => {
  state.beauticians = [];
  state.clients = [];
  state.messages = [];
  state.ai_actions = [];
  frontDesk.calls.length = 0;
  guarded.length = 0;
  smsSent.length = 0;
  logged.error.length = 0;
  logged.info.length = 0;
});

function salonAndClient({ autoReply }) {
  const b = {
    id: 'b1', first_name: 'Ellie', business_name: 'Ellindigo', auto_reply_enabled: autoReply,
    sms_originator: HER_NUMBER, sms_inbound_number: HER_NUMBER, sms_channel_id: null, sms_enabled: true,
  };
  state.beauticians.push(b);
  const c = {
    id: 'c1', beautician_id: 'b1', first_name: 'Sam', phone: CLIENT,
    marketing_consent: true, marketing_opted_out_at: null,
  };
  state.clients.push(c);
  return { b, c };
}

describe('Bird SMS: STOP with auto-reply OFF', () => {
  it('records the opt-out on the clients row and confirms it on SMS', async () => {
    const { c } = salonAndClient({ autoReply: false });

    await inboundSms(HER_NUMBER, CLIENT, 'STOP');

    // The exposure: this row is what every marketing engine reads.
    expect(c.marketing_opted_out_at).toBeTruthy();
    expect(c.marketing_consent).toBe(false);

    // The word is still in the thread, so Ellie can see it was said.
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].content).toBe('STOP');

    // Confirmed on the channel it arrived on, typed so the guard lets it out
    // to somebody who has just opted out.
    expect(guarded).toHaveLength(1);
    expect(guarded[0].messageType).toBe('marketing_opt_out');
    expect(guarded[0].channel).toBe('sms');
    expect(smsSent).toHaveLength(1);
    expect(smsSent[0].to).toBe(CLIENT);
    expect(smsSent[0].body).toMatch(/any more promotional messages/i);

    // The front desk never ran: auto-reply is off and STOP is not a question.
    expect(frontDesk.calls).toHaveLength(0);
  });

  it('does not let the front desk answer STOP even when auto-reply is on', async () => {
    const { c } = salonAndClient({ autoReply: true });

    await inboundSms(HER_NUMBER, CLIENT, 'unsubscribe');

    expect(c.marketing_opted_out_at).toBeTruthy();
    expect(guarded[0]?.messageType).toBe('marketing_opt_out');
    expect(frontDesk.calls).toHaveLength(0);
  });

  it('leaves an ordinary message alone, whichever way auto-reply is set', async () => {
    const { c } = salonAndClient({ autoReply: false });

    await inboundSms(HER_NUMBER, CLIENT, 'can you stop the 4pm and move it to 5?');

    expect(c.marketing_opted_out_at).toBeNull();
    expect(c.marketing_consent).toBe(true);
    expect(guarded).toHaveLength(0);
    expect(frontDesk.calls).toHaveLength(0);
  });
});
