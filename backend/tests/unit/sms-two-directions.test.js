/**
 * ONE COLUMN, TWO INCOMPATIBLE JOBS, AND AN ONBOARDING DEFAULT THAT TOOK EVERY
 * TENANT DOWN AT ONCE.
 *
 * `beauticians.sms_originator` was read two ways that can never agree:
 *
 *   outbound  services/notifications.js honoured it ONLY when it was a Bird
 *             channel id (a UUID). A phone number, and the database default
 *             'Florrie', were ignored and the text left from the shared long
 *             code +447418313493.
 *   inbound   routes/webhooks.js routed on
 *             `.eq('sms_originator', <the number the client texted>)`.
 *             A UUID never equals a phone number.
 *
 * There is no value that makes both directions work. That alone is a bug. What
 * made it a P0 is the default: Onboarding pre-filled the SMS fork with the
 * SHARED platform long code and told her to leave it as-is, and the config
 * endpoint accepted it with no uniqueness check. Two salons taking that fork
 * put the same number on two rows, `.maybeSingle()` turned that into a
 * PostgREST ambiguity error, the lookup returned null, and EVERY inbound SMS
 * was dropped for both of them, the pilot user included.
 *
 * There is a documented incident in this codebase where an unmatched Instagram
 * webhook fell back to `.limit(1).single()` and one salon's DMs were delivered
 * to a different salon. So the rule these tests pin is not "route better", it
 * is: if the number does not match EXACTLY ONE salon, log it and drop it.
 *
 * The fake below refuses a select that names a column the table does not have,
 * exactly as PostgREST does, and can be flipped between the schema that is live
 * TODAY (one sms_originator column) and the schema after the split migration.
 * Both must work, because this ships before the SQL is run.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

/* ------------------------------------------------------------------ schema --
 * The live shape today: 001 + 20260405_sms_originator.sql + 046 widening it.
 * There is no sms_channel_id and no sms_inbound_number yet.
 */
const LEGACY_BEAUTICIAN_COLUMNS = [
  'id', 'first_name', 'last_name', 'email', 'phone', 'business_name',
  'booking_slug', 'auto_reply_enabled', 'client_reminder_prefs',
  'sms_originator', 'sms_enabled',
];
/** After the split SQL in the report has been applied. */
const SPLIT_BEAUTICIAN_COLUMNS = [
  ...LEGACY_BEAUTICIAN_COLUMNS, 'sms_channel_id', 'sms_inbound_number',
];

const state = {
  columns: LEGACY_BEAUTICIAN_COLUMNS,
  beauticians: [],
  clients: [],
  messages: [],
};

const undefinedColumn = (col) => ({
  code: '42703',
  message: `column beauticians.${col} does not exist`,
  details: null,
  hint: null,
});

/** PostgREST validates every column named and rejects the WHOLE select. */
function parseSelect(table, spec) {
  if (table !== 'beauticians') return null;
  if (!spec || spec === '*') return null;
  for (const item of String(spec).split(',').map(s => s.trim()).filter(Boolean)) {
    if (item === '*') continue;
    const col = item.includes(':') ? item.split(':').pop().trim() : item;
    if (!state.columns.includes(col)) return undefinedColumn(col);
  }
  return null;
}

let ids = 0;
function makeBuilder(table) {
  const filters = [];
  let pending = null;
  let selectError = null;
  let limit = Infinity;

  const rows = () => (state[table] || []).filter(r => filters.every(f => f(r)));

  const settle = () => {
    if (selectError) return { data: null, error: selectError };
    if (pending?.op === 'update') {
      for (const col of Object.keys(pending.payload)) {
        if (table === 'beauticians' && !state.columns.includes(col)) {
          return { data: null, error: undefinedColumn(col) };
        }
      }
      const hit = rows();
      for (const r of hit) Object.assign(r, pending.payload);
      return { data: hit, error: null };
    }
    if (pending?.op === 'insert') {
      const payload = Array.isArray(pending.payload) ? pending.payload : [pending.payload];
      const created = payload.map(p => ({ id: `${table}_${++ids}`, created_at: new Date().toISOString(), ...p }));
      state[table].push(...created);
      return { data: created, error: null };
    }
    return { data: rows().slice(0, limit), error: null };
  };

  const b = {
    select(spec = '*') { selectError = parseSelect(table, spec); return b; },
    insert(p) { pending = { op: 'insert', payload: p }; return b; },
    update(p) { pending = { op: 'update', payload: p }; return b; },
    eq(c, v) { filters.push(r => r[c] === v); return b; },
    neq(c, v) { filters.push(r => r[c] !== v); return b; },
    is(c, v) { filters.push(r => (r[c] ?? null) === v); return b; },
    in(c, v) { filters.push(r => v.includes(r[c])); return b; },
    order() { return b; },
    limit(n) { limit = n; return b; },
    maybeSingle() { const o = settle(); return Promise.resolve(o.error ? o : { data: (o.data || [])[0] || null, error: null }); },
    single() { const o = settle(); return Promise.resolve(o.error ? o : { data: (o.data || [])[0] || null, error: null }); },
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

vi.mock('../../src/services/sms-metering.js', () => ({
  trackSMSUsage: async () => null,
  getSMSUsage: async () => null,
}));
vi.mock('../../src/services/whatsapp-metering.js', () => ({
  checkWhatsAppQuota: async () => ({ allowed: true }),
  trackWhatsAppMessage: async () => true,
  trackSmsInMonthlyQuota: async () => true,
  getMonthlyUsage: async () => null,
}));
vi.mock('../../src/lib/marketing-guard.js', () => ({
  isMarketingTemplate: () => false,
  isMarketingSmsType: () => false,
  canSendMarketing: async () => ({ allowed: true }),
  findClientByPhone: async () => null,
  inMarketingQuietHours: () => false,
}));
vi.mock('../../src/services/whatsapp-twilio.js', () => ({
  twilioConfigured: () => false,
  twilioSendText: async () => null,
  twilioSendTemplate: async () => null,
  twilioContentSid: () => null,
}));
const frontDesk = { calls: [] };
vi.mock('../../src/services/ai-front-desk.js', () => ({
  processInboundMessage: async (...args) => { frontDesk.calls.push(args); return { handled: true, intent: 'other' }; },
}));
vi.mock('../../src/services/delivery-receipts.js', () => ({ applyWhatsAppStatuses: async () => true }));
vi.mock('../../src/services/push-notifications.js', () => ({ pushMessagesWaiting: async () => true }));
vi.mock('../../src/lib/client-archive.js', () => ({ autoUnarchiveClient: async () => true }));
vi.mock('../../src/middleware/auth.js', () => ({ requireAuth: (_q, _s, next) => next() }));
vi.mock('../../src/middleware/security.js', () => ({ requireCronKey: (_q, _s, next) => next() }));
vi.mock('@anthropic-ai/sdk', () => ({ default: class { constructor() { this.messages = { create: async () => ({ content: [] }) }; } } }));

process.env.BIRD_API_KEY = 'test-key';
process.env.BIRD_WORKSPACE_ID = 'ws_1';
process.env.BIRD_SMS_CHANNEL_ID = '7e8e2014-98b9-508d-be22-6dde76d0dd0e';
// The Bird webhook fails closed without this since 2 September 2026: an
// unauthenticated inbound endpoint used to be the production default, and
// the tests were leaning on it. Every inbound text here carries the token.
process.env.BIRD_WEBHOOK_TOKEN = 'test-bird-webhook-token';

const SHARED = '+447418313493';
const PLATFORM_CHANNEL = '7e8e2014-98b9-508d-be22-6dde76d0dd0e';
const HER_CHANNEL = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const notifications = await import('../../src/services/notifications.js');
const { __resetSchemaProbeCache } = await import('../../src/lib/schema-probe.js');
const webhooksRouter = (await import('../../src/routes/webhooks.js')).default;
const notificationsRouter = (await import('../../src/routes/notifications.js')).default;

/** Drive one route handler straight, no HTTP server. */
async function run(router, method, path, req) {
  const layer = router.stack.find(l => l.route?.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`no ${method} ${path}`);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const out = { status: 200, body: null, sent: null };
  const res = {
    status(c) { out.status = c; return res; },
    json(p) { out.body = p; return res; },
    sendStatus(c) { out.sent = c; return res; },
  };
  await handler({ headers: {}, query: {}, body: {}, params: {}, beautician: { id: 'b1' }, ...req }, res);
  return out;
}

const inboundSms = (to, from = '+447900000001', body = 'can I move Thursday') =>
  run(webhooksRouter, 'post', '/bird-sms', {
    headers: { 'x-webhook-token': process.env.BIRD_WEBHOOK_TOKEN },
    body: { originator: from, recipient: to, payload: body, id: `ext_${++ids}` },
  });

/** Every fetch to Bird, so we can read which CHANNEL the text left from. */
const birdCalls = [];

beforeEach(() => {
  state.columns = LEGACY_BEAUTICIAN_COLUMNS;
  state.beauticians = [];
  state.clients = [];
  state.messages = [];
  frontDesk.calls.length = 0;
  birdCalls.length = 0;
  logged.error.length = 0;
  logged.warn.length = 0;
  logged.info.length = 0;
  __resetSchemaProbeCache();
  vi.stubGlobal('fetch', async (url) => {
    birdCalls.push(String(url));
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'msg_1' }), json: async () => ({ id: 'msg_1' }) };
  });
});

const salon = (over = {}) => {
  const row = {
    id: `b${state.beauticians.length + 1}`, first_name: 'Ellie', business_name: 'Ellindigo',
    email: `e${state.beauticians.length + 1}@x.com`, phone: null, auto_reply_enabled: true,
    client_reminder_prefs: {}, sms_originator: 'Florrie', sms_enabled: true,
    sms_channel_id: null, sms_inbound_number: null, ...over,
  };
  state.beauticians.push(row);
  return row;
};

/* ------------------------------------------------------------------------- */

describe('one column cannot hold both a channel id and a phone number', () => {
  it('splits every value that could plausibly be in sms_originator today', () => {
    const { splitLegacySmsOriginator: split } = notifications;

    // The database default. A brand sender name, and nothing else.
    expect(split('Florrie')).toEqual({ channelId: null, inboundNumber: null, senderName: 'Florrie' });

    // A Bird channel id: outbound only. It can never be texted.
    expect(split(HER_CHANNEL)).toEqual({ channelId: HER_CHANNEL, inboundNumber: null, senderName: null });

    // Her own virtual mobile: inbound only.
    expect(split('+447700900123')).toEqual({ channelId: null, inboundNumber: '+447700900123', senderName: null });
    // Same number, national spelling.
    expect(split('07700 900123').inboundNumber).toBe('+447700900123');

    // The SHARED long code is dropped, not migrated. It is not her number, and
    // keeping it is exactly what breaks every tenant at once.
    expect(split(SHARED)).toEqual({ channelId: null, inboundNumber: null, senderName: null });

    expect(split(null)).toEqual({ channelId: null, inboundNumber: null, senderName: null });
    expect(split('')).toEqual({ channelId: null, inboundNumber: null, senderName: null });
  });

  it('sends from her channel AND receives on her number, at the same time', async () => {
    // Impossible before the split: one column could be the UUID or the number.
    state.columns = SPLIT_BEAUTICIAN_COLUMNS;
    const b = salon({
      sms_channel_id: HER_CHANNEL,
      sms_inbound_number: '+447700900123',
      sms_originator: 'Ellindigo',
    });

    await notifications.sendSMS({ to: '+447900000001', body: 'see you Thursday', beauticianId: b.id });
    expect(birdCalls.some(u => u.includes(HER_CHANNEL))).toBe(true);
    expect(birdCalls.some(u => u.includes(PLATFORM_CHANNEL))).toBe(false);

    await inboundSms('+447700900123');
    expect(frontDesk.calls).toHaveLength(1);
    expect(frontDesk.calls[0][1].id).toBe(b.id);
  });

  it('says so loudly when she can receive but still sends from the shared number', async () => {
    state.columns = SPLIT_BEAUTICIAN_COLUMNS;
    const b = salon({ sms_inbound_number: '+447700900123', sms_channel_id: null });

    await notifications.sendSMS({ to: '+447900000001', body: 'hi', beauticianId: b.id });

    // The text goes out, on the shared channel, and the half-configured state
    // is on the record rather than being discovered by a client whose reply
    // vanished.
    expect(birdCalls.some(u => u.includes(PLATFORM_CHANNEL))).toBe(true);
    expect(logged.warn.some(l => /half-configured/i.test(l.msg || ''))).toBe(true);
  });
});

describe('inbound routing never resolves to an arbitrary tenant', () => {
  it('drops a text to the SHARED long code even when a salon row claims it', async () => {
    // Exactly what Onboarding used to write: the shared number, on one row.
    salon({ sms_originator: SHARED });

    await inboundSms(SHARED);

    expect(frontDesk.calls).toHaveLength(0);
    expect(state.messages).toHaveLength(0);
    expect(logged.error.some(l => /shared/i.test(l.msg || ''))).toBe(true);
  });

  it('drops it when TWO salons claim the same number, rather than picking one', async () => {
    // The Instagram incident, in SMS form. Two salons, one number.
    salon({ sms_originator: '+447700900123' });
    salon({ sms_originator: '+447700900123' });

    await inboundSms('+447700900123');

    expect(frontDesk.calls).toHaveLength(0);
    const complaint = logged.error.find(l => /more than one salon/i.test(l.msg || ''));
    expect(complaint).toBeTruthy();
    // The number is logged, so the ambiguity is fixable.
    expect(complaint.ctx.phoneNumber).toBe('+447700900123');
  });

  it('routes a number that exactly one salon holds, whatever way it is spelled', async () => {
    const b = salon({ sms_originator: '07700 900123' });
    salon({ sms_originator: 'Florrie' });

    await inboundSms('+447700900123');

    expect(frontDesk.calls).toHaveLength(1);
    expect(frontDesk.calls[0][1].id).toBe(b.id);
  });

  it('reads the new column once the split migration has run', async () => {
    state.columns = SPLIT_BEAUTICIAN_COLUMNS;
    const b = salon({ sms_inbound_number: '+447700900123', sms_originator: 'Ellindigo' });

    await inboundSms('+447700900123');

    expect(frontDesk.calls).toHaveLength(1);
    expect(frontDesk.calls[0][1].id).toBe(b.id);
  });

  it('drops a number nobody holds and logs it', async () => {
    salon({ sms_originator: 'Florrie' });

    await inboundSms('+447700900999');

    expect(frontDesk.calls).toHaveLength(0);
    expect(logged.error.some(l => /could not be routed/i.test(l.msg || ''))).toBe(true);
  });
});

describe('the shared number can no longer be handed to a tenant', () => {
  it('refuses the shared long code as an inbound number', async () => {
    const b = salon();
    const out = await run(notificationsRouter, 'put', '/sms/config', {
      beautician: { id: b.id },
      body: { sms_inbound_number: SHARED, sms_enabled: true },
    });

    expect(out.status).toBe(400);
    expect(out.body.error).toMatch(/shared Florrie number/i);
    expect(state.beauticians[0].sms_originator).toBe('Florrie');
  });

  it('refuses it through the legacy sms_originator field too', async () => {
    // This is the exact request the old onboarding fork sent, for every salon.
    const b = salon();
    const out = await run(notificationsRouter, 'put', '/sms/config', {
      beautician: { id: b.id },
      body: { sms_originator: SHARED, sms_enabled: true, channel: 'sms' },
    });

    expect(out.status).toBe(400);
    expect(out.body.error).toMatch(/shared Florrie number/i);
  });

  it('refuses a number another salon already receives on', async () => {
    salon({ sms_originator: '+447700900123' });
    const b = salon();

    const out = await run(notificationsRouter, 'put', '/sms/config', {
      beautician: { id: b.id },
      body: { sms_inbound_number: '+447700900123' },
    });

    expect(out.status).toBe(409);
    expect(out.body.error).toMatch(/already receives/i);
    expect(state.beauticians[1].sms_originator).toBe('Florrie');
  });

  it('accepts her own number, and reports honestly that replies now work', async () => {
    const b = salon();
    const out = await run(notificationsRouter, 'put', '/sms/config', {
      beautician: { id: b.id },
      body: { sms_inbound_number: '+447700900123', sms_enabled: true },
    });

    expect(out.status).toBe(200);
    expect(out.body.two_way).toBe(true);
    expect(out.body.sms_inbound_number).toBe('+447700900123');
    // Pre-migration there is one column, so that is where it goes, and inbound
    // routing reads it from there.
    expect(state.beauticians[0].sms_originator).toBe('+447700900123');

    await inboundSms('+447700900123');
    expect(frontDesk.calls).toHaveLength(1);
  });

  it('accepts an empty inbound number, and does not claim 2-way', async () => {
    // The common case: she has no number of her own. Onboarding used to fill
    // the shared one in for her here.
    const b = salon({ sms_originator: '+447700900123' });
    const out = await run(notificationsRouter, 'put', '/sms/config', {
      beautician: { id: b.id },
      body: { sms_inbound_number: null, sms_enabled: true, channel: 'sms' },
    });

    expect(out.status).toBe(200);
    expect(out.body.two_way).toBe(false);
    expect(state.beauticians[0].sms_originator).toBe(null);
  });

  it('reports the sender name, the channel and the number as three separate things', async () => {
    state.columns = SPLIT_BEAUTICIAN_COLUMNS;
    const b = salon({
      sms_originator: 'Ellindigo', sms_channel_id: HER_CHANNEL, sms_inbound_number: '+447700900123',
    });

    const out = await run(notificationsRouter, 'get', '/sms/config', { beautician: { id: b.id } });

    expect(out.body.sms_originator).toBe('Ellindigo');
    expect(out.body.sms_channel_id).toBe(HER_CHANNEL);
    expect(out.body.sms_inbound_number).toBe('+447700900123');
    expect(out.body.two_way).toBe(true);
    expect(out.body.schema_split).toBe(true);
  });

  it('does not 500 before the split columns exist', async () => {
    const b = salon({ sms_originator: 'Ellindigo' });
    const out = await run(notificationsRouter, 'get', '/sms/config', { beautician: { id: b.id } });

    expect(out.status).toBe(200);
    expect(out.body.schema_split).toBe(false);
    expect(out.body.sms_originator).toBe('Ellindigo');
    expect(out.body.two_way).toBe(false);
  });
});
