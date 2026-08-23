/**
 * The free path that was never taken.
 *
 * Meta lets you send free-form text to a number that messaged you in the last
 * 24 hours. That send costs nothing. Outside the window you need a pre-approved
 * template, which is billed, and Florrie's whole month is 120 messages before
 * a surcharge kicks in.
 *
 * inWhatsAppSession() decided which path sendNudge took, and it decided it by
 * reading `client.last_whatsapp_inbound_at`. That column is in no migration and
 * never has been. `undefined` is falsy, so the function returned false for
 * every client who has ever existed, and the free-form branch of sendNudge was
 * unreachable code. A client who messaged five minutes ago got a billable
 * template. Every nudge, every engine, for the life of the account.
 *
 * The real answer to "when did this client last message us" is the messages
 * table: one row per message with channel, direction and created_at. It is
 * already the source of truth for the identical Instagram 24h window in
 * sendOnPreferredChannel, ten screens further down the same file.
 *
 * messages.created_at is a REAL INSTANT, not the salon wall time convention
 * that appointments.starts_at uses, so ordinary Date arithmetic is right here.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

let inboundMessages = [];
const freeform = [];
const templates = [];
const smsSent = [];

// One beautician, WhatsApp connected. The rest of the tables are empty: the
// only read this test cares about is the one against `messages`.
const beauticians = [{ id: 'b1', whatsapp_phone_id: 'test-phone-id', wa_provider: 'meta', twilio_wa_sender: null, business_name: 'Ellindigo', first_name: 'Ellie' }];

function builder(table) {
  const filters = [];
  let desc = false;
  const source = () => (table === 'messages' ? inboundMessages : table === 'beauticians' ? beauticians : []);
  const rows = () => {
    let out = source().filter(r => filters.every(f => f(r)));
    if (desc) out = [...out].sort((x, y) => String(y.created_at || '').localeCompare(String(x.created_at || '')));
    return out;
  };
  const b = {
    select() { return b; },
    insert() { return b; },
    update() { return b; },
    eq(c, v) { filters.push(r => r[c] === v); return b; },
    order(_c, o) { desc = o?.ascending === false; return b; },
    limit() { return b; },
    maybeSingle() { return Promise.resolve({ data: rows()[0] || null, error: null }); },
    single() { return Promise.resolve({ data: rows()[0] || null, error: null }); },
    then(res, rej) { return Promise.resolve({ data: rows(), error: null }).then(res, rej); },
  };
  return b;
}

vi.mock('../../src/config.js', () => ({
  supabase: { from: builder },
  supabaseAnon: { from: builder },
}));
// Metering and delivery bookkeeping are not what this test is about.
vi.mock('../../src/services/whatsapp-metering.js', () => ({
  getMonthStart: () => '2026-08-01',
  checkWhatsAppQuota: async () => ({ allowed: true }),
  trackWhatsAppMessage: async () => true,
  trackSmsInMonthlyQuota: async () => true,
  getMonthlyUsage: async () => null,
  billMonthlySurplus: async () => ({}),
}));
vi.mock('../../src/services/sms-metering.js', () => ({
  getWeekStart: () => '2026-08-17',
  trackSMSUsage: async () => true,
  shouldAutoSend: async () => ({ shouldSend: true }),
  getSMSUsage: async () => null,
  billSurplusSMS: async () => ({}),
}));

// Intercept the wire. Which URL is hit is the whole question.
global.fetch = vi.fn(async (url, opts) => {
  const body = (() => { try { return JSON.parse(opts?.body || '{}'); } catch { return {}; } })();
  if (String(url).includes('graph.facebook.com')) {
    // Meta's send endpoint labels the two paths itself. type:'text' is the
    // free in-session message; type:'template' is the billable one. Anything
    // else on this host is Meta bookkeeping and is not a send.
    if (body.type === 'template') templates.push(body);
    else if (body.type === 'text') freeform.push(body);
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.1' }] }), text: async () => '' };
  }
  smsSent.push({ url: String(url), body });
  return { ok: true, status: 200, json: async () => ({ id: 'sms1' }), text: async () => '' };
});

process.env.WHATSAPP_TOKEN = 'test-token';
process.env.WHATSAPP_PHONE_ID = 'test-phone-id';

const { sendNudge } = await import('../../src/services/notifications.js');

const client = { id: 'c1', first_name: 'Shauna', whatsapp_id: '447700900000', phone: '+447700900000' };
const prefs = { whatsapp_connected: true };

const inbound = (minutesAgo) => ([{
  client_id: 'c1', channel: 'whatsapp', direction: 'inbound',
  created_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
}]);

beforeEach(() => {
  inboundMessages = [];
  freeform.length = 0;
  templates.length = 0;
  smsSent.length = 0;
});

describe('a client who messaged five minutes ago', () => {
  it('gets the free free-form message, not a billable template', async () => {
    inboundMessages = inbound(5);

    const result = await sendNudge({
      client, body: 'Fancy booking in?', templateName: 'rebook_nudge_v2',
      templateParams: ['Shauna'], beauticianId: 'b1', beauticianPrefs: prefs,
    });

    expect(result?.channel).toBe('whatsapp_freeform');
    expect(freeform).toHaveLength(1);
    expect(templates).toHaveLength(0);
  });

  it('holds right up to the edge of the window', async () => {
    inboundMessages = inbound(23 * 60 + 50); // 23h50m

    const result = await sendNudge({
      client, body: 'Fancy booking in?', templateName: 'rebook_nudge_v2',
      templateParams: ['Shauna'], beauticianId: 'b1', beauticianPrefs: prefs,
    });

    expect(result?.channel).toBe('whatsapp_freeform');
  });
});

describe('a client who last messaged two days ago', () => {
  it('correctly falls through to the template, because Meta would refuse the other', async () => {
    inboundMessages = inbound(48 * 60);

    const result = await sendNudge({
      client, body: 'Fancy booking in?', templateName: 'rebook_nudge_v2',
      templateParams: ['Shauna'], beauticianId: 'b1', beauticianPrefs: prefs,
    });

    expect(result?.channel).toBe('whatsapp_template');
    expect(freeform).toHaveLength(0);
    expect(templates).toHaveLength(1);
  });
});

describe('a client who has never messaged us on WhatsApp', () => {
  it('gets the template, and the window check does not throw on an empty history', async () => {
    inboundMessages = [];

    const result = await sendNudge({
      client, body: 'Fancy booking in?', templateName: 'rebook_nudge_v2',
      templateParams: ['Shauna'], beauticianId: 'b1', beauticianPrefs: prefs,
    });

    expect(result?.channel).toBe('whatsapp_template');
  });

  it('and an OUTBOUND message from us does not open the window', async () => {
    // Only the client messaging us opens Meta's service window. A nudge WE
    // sent an hour ago must not be read as her having replied.
    inboundMessages = [{
      client_id: 'c1', channel: 'whatsapp', direction: 'outbound',
      created_at: new Date(Date.now() - 60 * 60_000).toISOString(),
    }];

    const result = await sendNudge({
      client, body: 'Fancy booking in?', templateName: 'rebook_nudge_v2',
      templateParams: ['Shauna'], beauticianId: 'b1', beauticianPrefs: prefs,
    });

    expect(result?.channel).toBe('whatsapp_template');
  });

  it('and an INSTAGRAM message does not open the WhatsApp window either', async () => {
    inboundMessages = [{
      client_id: 'c1', channel: 'instagram', direction: 'inbound',
      created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    }];

    const result = await sendNudge({
      client, body: 'Fancy booking in?', templateName: 'rebook_nudge_v2',
      templateParams: ['Shauna'], beauticianId: 'b1', beauticianPrefs: prefs,
    });

    expect(result?.channel).toBe('whatsapp_template');
  });
});

describe('the column that started it', () => {
  it('is gone from the source tree', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const SRC = new URL('../../src/', import.meta.url).pathname;

    const offenders = [];
    (function walk(dir) {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (e.endsWith('.js')) {
          const src = readFileSync(p, 'utf8');
          for (const [i, line] of src.split('\n').entries()) {
            // Skip the comments that explain why it is gone.
            if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) continue;
            if (line.includes('last_whatsapp_inbound_at')) offenders.push(`${p}:${i + 1}`);
          }
        }
      }
    })(SRC);

    expect(offenders).toEqual([]);
  });
});
