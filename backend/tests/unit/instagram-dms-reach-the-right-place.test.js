/**
 * INSTAGRAM'S FIRST NIGHT LIVE, 31 AUGUST 2026.
 *
 * @ellindigo connected an Instagram account for the first time that evening
 * (connected: true, page_name: ellindigo, webhook_subscribed: true), and every
 * defect pinned in this file went from theoretical to live at that moment.
 * Each test is one thing that was actually wrong with the DM path:
 *
 *   1. A reply to an Instagram DM went out on whatever channel the CLIENT
 *      RECORD preferred, not the one the message arrived on. preferred_channel
 *      is only ever set to 'instagram' when the client row is created from a
 *      DM, so an existing WhatsApp or SMS client who wrote in on Instagram had
 *      Florrie answer her by text, in a conversation that was happening
 *      somewhere else entirely.
 *
 *   2. STOP was only honoured inside processInboundMessage, and Instagram's
 *      'redirect' and 'off' modes never reach it. So the single most likely
 *      message to be answered with STOP, an automated "message me on WhatsApp
 *      instead", was the one message whose STOP was thrown away.
 *
 *   3. The redirect auto-reply went out with NOTHING on the path: no consent
 *      check, no opt-out check, no outbound_sends row. It was the only
 *      auto-send in the codebase that reached a client ungated.
 *
 *   4. Every non-text DM was dropped on the floor by `if (!event.message?.text)
 *      return;`. No row, no thread, no push, no log. On Instagram, sending a
 *      photo of the lashes you want IS how people ask for an appointment.
 *
 * The fake Supabase does what PostgREST does: it knows the real column lists
 * from supabase/migrations and rejects a select, insert or update naming
 * anything else, by RESOLVING with { data: null, error } rather than throwing.
 */
process.env.TZ = 'UTC';
process.env.INSTAGRAM_APP_SECRET = 'ig-app-secret';
process.env.INSTAGRAM_VERIFY_TOKEN = 'verify-me';
process.env.ANTHROPIC_API_KEY = 'sk-test';

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import express from 'express';
import { createServer } from 'http';
import crypto from 'crypto';

// The night in question. Everything under test that reads a clock reads this
// one, so nothing here can start failing in November.
const NOW = new Date('2026-08-31T21:40:00.000Z');
vi.useFakeTimers({ toFake: ['Date'] });
vi.setSystemTime(NOW);

/* ------------------------------------------------------------------ schema --
 * Columns taken from supabase/migrations. Only the tables this path touches.
 *
 *   beauticians     001, 021, 032_instagram_dm_control, 038, 066 (autonomy)
 *   clients         001, 021, 032, 055 (marketing_opted_out_at),
 *                   077 (messaging_autonomy), 20260727_backend016
 *   messages        001, 20260727_backend016, 20260805_message_authorship
 *   outbound_sends  066_outbound_guard
 */
const BASE_COLUMNS = {
  beauticians: [
    'id', 'auth_id', 'email', 'first_name', 'last_name', 'business_name', 'phone',
    'timezone', 'auto_reply_enabled', 'confidence_threshold', 'tone_model',
    'working_hours', 'created_at', 'autonomy',
    'instagram_page_id', 'instagram_page_token', 'instagram_page_name',
    'instagram_dm_mode', 'instagram_redirect_message',
    'whatsapp_phone_id', 'whatsapp_token',
  ],
  clients: [
    'id', 'beautician_id', 'first_name', 'last_name', 'phone', 'email',
    'whatsapp_id', 'instagram_id', 'preferred_channel', 'status', 'created_at',
    'marketing_consent', 'marketing_consent_at', 'marketing_opted_out_at',
    'messaging_autonomy', 'is_regular', 'vip',
    'instagram_redirect_sent_at', 'instagram_username',
  ],
  messages: [
    'id', 'beautician_id', 'client_id', 'channel', 'direction', 'content',
    'external_message_id', 'ai_handled', 'ai_confidence', 'ai_intent',
    'ai_response', 'tone_match_score', 'escalated', 'resolved',
    'media_url', 'media_type', 'created_at',
    'is_junk', 'junk_reason', 'authored_by', 'digital_employee',
  ],
  ai_actions: [
    'id', 'beautician_id', 'action_type', 'digital_employee', 'summary',
    'details', 'confidence', 'autonomous', 'client_id', 'appointment_id',
    'message_id', 'outcome', 'notification_sent', 'notification_text',
    'created_at',
  ],
  outbound_sends: [
    'id', 'beautician_id', 'client_id', 'message_type', 'tier', 'channel',
    'status', 'reason', 'body', 'created_at', 'decided_at',
  ],
  appointments: ['id', 'beautician_id', 'client_id', 'starts_at', 'status'],
};

let COLUMNS = {};
const resetSchema = () => {
  COLUMNS = Object.fromEntries(Object.entries(BASE_COLUMNS).map(([t, c]) => [t, [...c]]));
};
resetSchema();

const db = { beauticians: [], clients: [], messages: [], ai_actions: [], outbound_sends: [], appointments: [] };
let idCounter = 0;
const nextId = (p) => `${p}_${++idCounter}`;

const undefinedColumn = (table, col) => ({ code: '42703', message: `column ${table}.${col} does not exist` });
const unknownWriteColumn = (table, col) => ({ code: 'PGRST204', message: `Could not find the '${col}' column of '${table}' in the schema cache` });

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

function parseSelect(table, spec) {
  if (!spec || spec === '*') return null;
  const known = COLUMNS[table];
  if (!known) return null;
  for (const item of splitTop(spec)) {
    const col = item.includes(':') ? item.split(':').pop().trim() : item;
    if (col === '*' || col.includes('(')) continue;
    if (!known.includes(col)) return undefinedColumn(table, col);
  }
  return null;
}

/** A write is rejected WHOLE if any one column is unknown, exactly as PostgREST does. */
function parseWrite(table, payload) {
  const known = COLUMNS[table];
  if (!known) return null;
  for (const row of (Array.isArray(payload) ? payload : [payload])) {
    for (const col of Object.keys(row || {})) {
      if (!known.includes(col)) return unknownWriteColumn(table, col);
    }
  }
  return null;
}

function makeBuilder(table) {
  const filters = [];
  let pending = null;
  let selectError = null;
  let writeError = null;

  const matching = () => (db[table] || []).filter(r => filters.every(f => f(r)));

  const settle = () => {
    if (writeError) return { data: null, error: writeError, count: null };
    if (selectError) return { data: null, error: selectError, count: null };
    if (pending?.op === 'insert') {
      const payload = Array.isArray(pending.payload) ? pending.payload : [pending.payload];
      const created = payload.map(p => ({ id: nextId(table), created_at: new Date().toISOString(), ...p }));
      db[table].push(...created);
      return { data: created, error: null, count: created.length };
    }
    if (pending?.op === 'update') {
      const rows = matching();
      for (const r of rows) Object.assign(r, pending.payload);
      return { data: rows, error: null, count: rows.length };
    }
    const rows = matching();
    return { data: rows.map(r => ({ ...r })), error: null, count: rows.length };
  };

  const b = {
    select(spec = '*') { selectError = parseSelect(table, spec); return b; },
    insert(p) { pending = { op: 'insert', payload: p }; writeError = parseWrite(table, p); return b; },
    update(p) { pending = { op: 'update', payload: p }; writeError = parseWrite(table, p); return b; },
    eq(c, v) { filters.push(r => r[c] === v); return b; },
    neq(c, v) { filters.push(r => r[c] !== v); return b; },
    in(c, v) { filters.push(r => v.map(String).includes(String(r[c]))); return b; },
    is(c, v) { filters.push(r => (r[c] ?? null) === v); return b; },
    not(c) { filters.push(r => (r[c] ?? null) !== null); return b; },
    or() { return b; },
    overlaps(c, v) {
      if (COLUMNS[table] && !COLUMNS[table].includes(c)) { selectError = undefinedColumn(table, c); return b; }
      const want = (v || []).map(String);
      filters.push(r => Array.isArray(r[c]) && r[c].some(x => want.includes(String(x))));
      return b;
    },
    gte(c, v) { filters.push(r => String(r[c]) >= String(v)); return b; },
    lte(c, v) { filters.push(r => String(r[c]) <= String(v)); return b; },
    gt(c, v) { filters.push(r => String(r[c]) > String(v)); return b; },
    lt(c, v) { filters.push(r => String(r[c]) < String(v)); return b; },
    order() { return b; },
    limit() { return b; },
    maybeSingle() { const o = settle(); return Promise.resolve(o.error ? o : { data: (o.data || [])[0] || null, error: null }); },
    single() { const o = settle(); return Promise.resolve(o.error ? o : { data: (o.data || [])[0] || null, error: null }); },
    then(res, rej) { return Promise.resolve(settle()).then(res, rej); },
    catch(rej) { return Promise.resolve(settle()).catch(rej); },
  };
  return b;
}

vi.mock('../../src/config.js', () => ({ supabase: { from: (t) => makeBuilder(t) } }));

/* -------------------------------------------------------------------- logs -- */
const logs = { warn: [], error: [], info: [] };
vi.mock('../../src/lib/logger.js', () => {
  const rec = (level) => (a, b) => { logs[level].push({ ctx: typeof a === 'object' ? a : {}, msg: typeof a === 'string' ? a : b }); };
  return { default: { warn: rec('warn'), error: rec('error'), info: rec('info'), debug: () => {} } };
});

/* ------------------------------------------------------------------- mocks --
 * The senders are recorded, not stubbed away: WHICH ONE was called is the
 * whole point of the first test.
 */
const sends = [];
vi.mock('../../src/services/notifications.js', () => ({
  sendInstagramDM: async (args) => { sends.push({ via: 'instagram', ...args }); return { message_id: 'ig-out-1' }; },
  sendWhatsAppText: async (args) => { sends.push({ via: 'whatsapp', ...args }); return { messages: [{ id: 'wa-out-1' }] }; },
  sendSMS: async (args) => { sends.push({ via: 'sms', ...args }); return { id: 'sms-out-1' }; },
  sendMessage: async (args) => { sends.push({ via: 'auto', ...args }); return true; },
  notifyBookingConfirmed: async () => true,
  sendOnPreferredChannel: async () => ({ ok: true, channel: 'sms' }),
}));
vi.mock('../../src/services/push-notifications.js', () => ({
  pushMessagesWaiting: async () => true,
  pushEscalation: async () => true,
  pushTeamUpdate: async () => true,
  pushAtTheDoor: async () => ({ channel: 'push' }),
}));
vi.mock('../../src/services/live-activity.js', () => ({ refreshLiveActivity: async () => true }));
vi.mock('../../src/lib/client-archive.js', () => ({ autoUnarchiveClient: async () => true }));
vi.mock('@sentry/node', () => ({ captureMessage: () => {}, captureException: () => {} }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    constructor() {
      this.messages = { create: async () => ({ content: [{ text: '{}' }] }) };
    }
  },
}));

/* ------------------------------------------------------------------- fetch --
 * Every Graph call is recorded. Calls to the local test server pass through.
 */
const realFetch = globalThis.fetch;
let graph = {};
const graphCalls = [];
const ok = (body) => ({ ok: true, status: 200, json: async () => body });

vi.stubGlobal('fetch', async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.includes('127.0.0.1') || url.includes('localhost')) return realFetch(input, init);
  graphCalls.push({ url, method: init?.method || 'GET', body: (() => { try { return JSON.parse(init?.body); } catch { return init?.body || null; } })() });
  for (const pattern of Object.keys(graph).sort((a, b) => b.length - a.length)) {
    if (url.includes(pattern)) { const r = await graph[pattern](url, init); return { ok: r.ok !== false, status: r.status || 200, json: async () => r.json ? r.json() : r.body }; }
  }
  return { ok: false, status: 404, json: async () => ({ error: { message: `no stub for ${url}` } }) };
});

/* ------------------------------------------------------------------ module -- */
const { default: webhookRouter } = await import('../../src/routes/instagram-webhooks.js');
const { processInboundMessage } = await import('../../src/services/ai-front-desk.js');

const app = express();
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use('/api/webhooks/instagram', webhookRouter);
const server = createServer(app);
await new Promise(r => server.listen(0, r));
const PORT = server.address().port;
afterAll(() => { server.close(); vi.useRealTimers(); });

const IG_ACCOUNT = '17841426032033812';   // ellindigo, as Meta reports it
const SENDER = '6543210987654321';

async function postWebhook(payload) {
  const raw = JSON.stringify(payload);
  const sig = 'sha256=' + crypto.createHmac('sha256', process.env.INSTAGRAM_APP_SECRET).update(raw).digest('hex');
  const r = await realFetch(`http://127.0.0.1:${PORT}/api/webhooks/instagram`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': sig },
    body: raw,
  });
  // The route answers 200 before it processes, so let the async half finish.
  await new Promise(res => setTimeout(res, 40));
  return r.status;
}

const dm = (message) => ({
  object: 'instagram',
  entry: [{ id: IG_ACCOUNT, time: NOW.getTime(), messaging: [{
    sender: { id: SENDER }, recipient: { id: IG_ACCOUNT }, timestamp: NOW.getTime(), message,
  }] }],
});

function seedSalon(over = {}) {
  db.beauticians = [{
    id: 'b-ellie',
    first_name: 'Ellie',
    business_name: 'Ellindigo',
    phone: '07700900123',
    timezone: 'Europe/London',
    instagram_page_id: IG_ACCOUNT,
    instagram_page_token: 'IGQVJ-long-lived',
    instagram_page_name: 'ellindigo',
    instagram_dm_mode: 'redirect',
    auto_reply_enabled: false,
    autonomy: {},
    ...over,
  }];
  return db.beauticians[0];
}

/** A client Ellie already had, on WhatsApp, before Instagram existed. */
function seedWhatsAppClient(over = {}) {
  db.clients = [{
    id: 'c-sophie',
    beautician_id: 'b-ellie',
    first_name: 'Sophie',
    phone: '+447700900456',
    whatsapp_id: '447700900456',
    instagram_id: SENDER,
    preferred_channel: 'whatsapp',
    status: 'active',
    marketing_consent: true,
    marketing_opted_out_at: null,
    created_at: '2026-02-01T10:00:00.000Z',
    ...over,
  }];
  return db.clients[0];
}

beforeEach(() => {
  resetSchema();
  for (const k of Object.keys(db)) db[k] = [];
  logs.warn.length = 0; logs.error.length = 0; logs.info.length = 0;
  sends.length = 0;
  graphCalls.length = 0;
  idCounter = 0;
  graph = {
    'me/messages': () => ok({ message_id: 'mid.out' }),
    [`graph.instagram.com/v21.0/${SENDER}`]: () => ok({ name: 'Sophie', username: 'sophie.b' }),
  };
  vi.setSystemTime(NOW);
});

/* =========================================================================== */
describe('a reply goes back on the channel the message came in on', () => {
  it('answers an existing WhatsApp client ON INSTAGRAM when she DMs', async () => {
    // The exact production shape: a client Ellie has messaged on WhatsApp for
    // months (preferred_channel 'whatsapp', a real phone, a real whatsapp_id)
    // sends an Instagram DM. Before 31 August 2026 sendResponse read
    // preferred_channel and this reply went out as a WhatsApp message.
    //
    // STOP is used as the message because it is the one branch of the front
    // desk that is fully deterministic: no model call, no classifier, and it
    // still runs the whole delivery path.
    const beautician = seedSalon({ instagram_dm_mode: 'ai' });
    const client = seedWhatsAppClient();
    db.messages = [{ id: 'm-1', beautician_id: 'b-ellie', client_id: client.id, channel: 'instagram', direction: 'inbound', content: 'STOP' }];

    await processInboundMessage('m-1', beautician, client, 'STOP', 'instagram');

    expect(sends).toHaveLength(1);
    expect(sends[0].via).toBe('instagram');
    expect(sends[0].recipientId).toBe(SENDER);
    // And the row we write about it says instagram too, so the thread and the
    // history agree with what actually happened.
    const outbound = db.messages.filter(m => m.direction === 'outbound');
    expect(outbound).toHaveLength(1);
    expect(outbound[0].channel).toBe('instagram');
  });

  it('still uses the stored preference when the caller does not know the channel', async () => {
    // The other four callers (webhooks.js x3, whatsapp-config.js,
    // twilio-webhooks.js) pass no channel, and none of their behaviour may
    // change: the argument defaults, it does not override.
    const beautician = seedSalon({ instagram_dm_mode: 'ai', whatsapp_phone_id: 'wa-phone-1' });
    const client = seedWhatsAppClient({ instagram_id: null });
    db.messages = [{ id: 'm-1', beautician_id: 'b-ellie', client_id: client.id, channel: 'whatsapp', direction: 'inbound', content: 'STOP' }];

    await processInboundMessage('m-1', beautician, client, 'STOP');

    expect(sends).toHaveLength(1);
    expect(sends[0].via).toBe('whatsapp');
  });

  it('hands the front desk the channel when the DM arrives on Instagram', async () => {
    // End of the same wire, from the webhook in. dmMode 'ai' with a plain
    // question would need the model; STOP proves the argument reaches the
    // front desk and comes back out on the right transport.
    seedSalon({ instagram_dm_mode: 'ai' });
    seedWhatsAppClient();

    expect(await postWebhook(dm({ mid: 'mid.1', text: 'STOP' }))).toBe(200);

    const outTo = graphCalls.filter(c => c.url.includes('me/messages'));
    expect(outTo).toHaveLength(1);
    expect(outTo[0].body.recipient.id).toBe(SENDER);
    // Nothing went out by text or WhatsApp to a woman who wrote on Instagram.
    expect(sends.filter(s => s.via === 'sms' || s.via === 'whatsapp')).toHaveLength(0);
  });
});

/* =========================================================================== */
describe('STOP is honoured on every Instagram mode, not just the one', () => {
  it('sets the opt-out when STOP answers a redirect auto-reply', async () => {
    seedSalon({ instagram_dm_mode: 'redirect' });
    seedWhatsAppClient({ instagram_redirect_sent_at: '2026-08-31T09:00:00.000Z' });

    expect(await postWebhook(dm({ mid: 'mid.stop', text: 'STOP' }))).toBe(200);

    const client = db.clients[0];
    expect(client.marketing_opted_out_at).toBe(NOW.toISOString());
    expect(client.marketing_consent).toBe(false);
    // And it is on the activity feed, because a consent change is a thing that
    // happened to a client and not a private server event.
    expect(db.ai_actions.some(a => a.action_type === 'marketing_opt_out')).toBe(true);
  });

  it('sets the opt-out in "off" mode too, and stays silent while doing it', async () => {
    // 'off' means she reads everything herself. It does not mean the word STOP
    // stops meaning anything.
    seedSalon({ instagram_dm_mode: 'off' });
    seedWhatsAppClient();

    expect(await postWebhook(dm({ mid: 'mid.stop2', text: 'stop' }))).toBe(200);

    expect(db.clients[0].marketing_opted_out_at).toBe(NOW.toISOString());
    expect(graphCalls.filter(c => c.url.includes('me/messages'))).toHaveLength(0);
  });

  it('does not treat an ordinary message that contains the word as an opt-out', async () => {
    seedSalon({ instagram_dm_mode: 'off' });
    seedWhatsAppClient();

    await postWebhook(dm({ mid: 'mid.3', text: 'can you stop by at 4 instead?' }));

    expect(db.clients[0].marketing_opted_out_at).toBeNull();
  });
});

/* =========================================================================== */
describe('the redirect auto-reply goes through the outbound gate', () => {
  it('records the send, and only then writes the throttle', async () => {
    seedSalon({ instagram_dm_mode: 'redirect' });
    seedWhatsAppClient();

    expect(await postWebhook(dm({ mid: 'mid.4', text: 'hiya do you do lash lifts?' }))).toBe(200);

    // It went.
    expect(graphCalls.filter(c => c.url.includes('me/messages'))).toHaveLength(1);
    // Through the gate, with a row to show for it. Before 31 August 2026 this
    // table had never seen an Instagram redirect at all.
    expect(db.outbound_sends).toHaveLength(1);
    expect(db.outbound_sends[0]).toMatchObject({
      message_type: 'instagram_redirect',
      channel: 'instagram',
      status: 'sent',
      client_id: 'c-sophie',
    });
    // And the throttle that stops it happening again for 7 days is saved.
    expect(db.clients[0].instagram_redirect_sent_at).toBe(NOW.toISOString());
    // And it is in her thread.
    expect(db.messages.filter(m => m.direction === 'outbound')).toHaveLength(1);
  });

  it('REFUSES to redirect a client who has opted out, and says why', async () => {
    seedSalon({ instagram_dm_mode: 'redirect' });
    seedWhatsAppClient({ marketing_opted_out_at: '2026-08-20T12:00:00.000Z', marketing_consent: false });

    expect(await postWebhook(dm({ mid: 'mid.5', text: 'hello?' }))).toBe(200);

    // Nothing was sent.
    expect(graphCalls.filter(c => c.url.includes('me/messages'))).toHaveLength(0);
    // The refusal is recorded, not silent.
    expect(db.outbound_sends).toHaveLength(1);
    expect(db.outbound_sends[0]).toMatchObject({ message_type: 'instagram_redirect', status: 'blocked', reason: 'opted_out' });
    // Her message is still stored and still in the inbox. Opting out of
    // marketing is not opting out of being a client.
    expect(db.messages.filter(m => m.direction === 'inbound')).toHaveLength(1);
  });

  it('shouts when the throttle write fails, because the symptom is invisible', async () => {
    // Drop the column, which is what an unapplied migration looks like to
    // PostgREST. The redirect still goes out; what must not happen is silence,
    // because a throttle that never saves fires on every DM forever.
    seedSalon({ instagram_dm_mode: 'redirect' });
    seedWhatsAppClient();
    COLUMNS.clients = COLUMNS.clients.filter(c => c !== 'instagram_redirect_sent_at');

    await postWebhook(dm({ mid: 'mid.6', text: 'hiya' }));

    expect(logs.error.some(l => /redirect throttle NOT saved/i.test(l.msg || ''))).toBe(true);
  });
});

/* =========================================================================== */
describe('a DM that is not words is still a DM', () => {
  it('stores a photo-only DM with its media, and does not try to answer it', async () => {
    seedSalon({ instagram_dm_mode: 'ai' });
    seedWhatsAppClient();

    expect(await postWebhook(dm({
      mid: 'mid.photo',
      attachments: [{ type: 'image', payload: { url: 'https://lookaside.fbsbx.com/ig_messaging/abc.jpg' } }],
    }))).toBe(200);

    expect(db.messages).toHaveLength(1);
    const row = db.messages[0];
    expect(row.media_type).toBe('image');
    expect(row.media_url).toBe('https://lookaside.fbsbx.com/ig_messaging/abc.jpg');
    // Never blank: routes/inbox.js renders content, and an empty thread row
    // reads as a bug rather than as a photo.
    expect(row.content).toBe('[Photo]');
    expect(row.channel).toBe('instagram');
    expect(row.client_id).toBe('c-sophie');

    // Florrie has not seen the picture, so she does not get to answer it.
    expect(graphCalls.filter(c => c.url.includes('me/messages'))).toHaveLength(0);
    expect(sends).toHaveLength(0);
    expect(db.messages.filter(m => m.direction === 'outbound')).toHaveLength(0);
  });

  it('stores a voice note, a reel share and a story mention rather than binning them', async () => {
    seedSalon({ instagram_dm_mode: 'off' });
    seedWhatsAppClient();

    await postWebhook(dm({ mid: 'a1', attachments: [{ type: 'audio', payload: { url: 'https://cdn/x.m4a' } }] }));
    await postWebhook(dm({ mid: 'a2', attachments: [{ type: 'ig_reel', payload: { url: 'https://cdn/r.mp4' } }] }));
    await postWebhook(dm({ mid: 'a3', attachments: [{ type: 'story_mention', payload: { url: 'https://cdn/s.jpg' } }] }));

    expect(db.messages.map(m => m.media_type)).toEqual(['audio', 'video', 'story_mention']);
    expect(db.messages.map(m => m.content)).toEqual(['[Voice note]', '[Shared a reel]', '[Mentioned you in a story]']);
  });

  it('does not answer a photo with the WhatsApp redirect either', async () => {
    seedSalon({ instagram_dm_mode: 'redirect' });
    seedWhatsAppClient();

    await postWebhook(dm({ mid: 'mid.photo2', attachments: [{ type: 'image', payload: { url: 'https://cdn/y.jpg' } }] }));

    expect(db.messages).toHaveLength(1);
    expect(graphCalls.filter(c => c.url.includes('me/messages'))).toHaveLength(0);
    expect(db.outbound_sends).toHaveLength(0);
  });

  it('still ignores read receipts and reactions, which carry no message at all', async () => {
    seedSalon();
    seedWhatsAppClient();

    await postWebhook({ object: 'instagram', entry: [{ id: IG_ACCOUNT, messaging: [{ sender: { id: SENDER }, recipient: { id: IG_ACCOUNT }, read: { mid: 'x' } }] }] });
    await postWebhook({ object: 'instagram', entry: [{ id: IG_ACCOUNT, messaging: [{ sender: { id: SENDER }, recipient: { id: IG_ACCOUNT }, reaction: { emoji: '❤️' } }] }] });

    expect(db.messages).toHaveLength(0);
  });
});

/* =========================================================================== */
describe('an unset DM mode means silence, not an auto-reply nobody chose', () => {
  it('says nothing at all when instagram_dm_mode has never been set', async () => {
    // The default used to be 'redirect', so a salon that had never opened the
    // setting sent "message me on WhatsApp" to every stranger who wrote in.
    // routes/instagram.js already writes 'off' at connect time for exactly
    // this reason; this is the rule applied to the rows that predate it.
    seedSalon({ instagram_dm_mode: null });
    seedWhatsAppClient();

    await postWebhook(dm({ mid: 'mid.7', text: 'hiya, any space Friday?' }));

    expect(db.messages).toHaveLength(1);              // stored, so she sees it
    expect(graphCalls.filter(c => c.url.includes('me/messages'))).toHaveLength(0);
  });
});

/* =========================================================================== */
describe('a failed write is never silent', () => {
  it('says out loud that a DM will not appear in the Inbox when the client insert fails', async () => {
    // routes/inbox.js skips every message row with no client_id, so a failed
    // client insert used to mean the DM existed in the table and nowhere in
    // the product, with nothing logged either way.
    seedSalon({ instagram_dm_mode: 'off' });
    db.clients = [];
    COLUMNS.clients = COLUMNS.clients.filter(c => c !== 'preferred_channel');

    await postWebhook(dm({ mid: 'mid.8', text: 'hello' }));

    expect(logs.error.some(l => /could not create the client/i.test(l.msg || ''))).toBe(true);
    expect(logs.error.some(l => /will NOT appear in the Inbox/i.test(l.msg || ''))).toBe(true);
  });

  it('says out loud when the message itself could not be stored', async () => {
    seedSalon({ instagram_dm_mode: 'off' });
    seedWhatsAppClient();
    COLUMNS.messages = COLUMNS.messages.filter(c => c !== 'media_type');

    await postWebhook(dm({ mid: 'mid.9', attachments: [{ type: 'image', payload: { url: 'https://cdn/z.jpg' } }] }));

    expect(db.messages).toHaveLength(0);
    expect(logs.error.some(l => /This DM is lost/i.test(l.msg || ''))).toBe(true);
  });
});
