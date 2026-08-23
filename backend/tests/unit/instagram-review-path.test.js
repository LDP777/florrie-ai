/**
 * THE INSTAGRAM PATH, AS TWO META APP REVIEW SCREENCASTS WILL WALK IT.
 *
 * Two videos have to be recorded against this code, and a 500 on camera is a
 * re-record. Each test here is one of the ways it has actually broken before.
 *
 * VIDEO 1, messaging. A DM sent from another Instagram account has to land in
 * the Florrie inbox against the right salon.
 *
 *   The account id stored at connect time and the id Meta puts in the webhook
 *   have disagreed in production: a stored instagram_page_id was flatly wrong
 *   and DMs did not route until somebody edited the row by hand. The reason is
 *   that graph.instagram.com/me returns BOTH an `id` and a `user_id` and they
 *   are not the same number, while Meta's webhook reference calls entry.id
 *   only "the object's ID" and tells you to verify a delivery by looking at
 *   recipient.id. So the connect flow now keeps every id it learns, and the
 *   webhook matches on any of them, against entry.id AND recipient.id.
 *
 *   The old ".limit(1).single()" fallback that handed an unmatched DM to an
 *   arbitrary beautician stays gone, and is pinned here so it cannot come back.
 *
 * VIDEO 2, publishing. A draft with a photo has to reach the profile.
 *
 *   Instagram fetches the image from the url ITSELF, server side, so a signed
 *   or private link fails at Meta and not at us. And the two step flow is only
 *   correct if the container's status is polled before media_publish: the old
 *   code published immediately, read neither response, and marked the post
 *   'posted' with an undefined external id. A draft that looks published and
 *   is not on the profile is exactly the frame that ends a recording session.
 *
 * The fake Supabase below does what PostgREST does: it knows the real column
 * lists (taken from supabase/migrations) and rejects a select, insert or
 * update that names anything else, by RESOLVING with { data: null, error },
 * never by throwing. Two of the fixes here deliberately write columns that do
 * not exist yet, and the point of the fake is to prove those writes fail SOFT:
 * the connect flow must still save the token when instagram_account_ids is
 * missing, because a missing migration turning into a connect that saves
 * nothing is far worse than routing on one id.
 */
process.env.TZ = 'UTC';
process.env.ENCRYPTION_KEY = 'test-encryption-key-for-oauth-state-signing';
process.env.INSTAGRAM_APP_ID = '1427547881961219';
process.env.INSTAGRAM_APP_SECRET = 'ig-app-secret';
process.env.INSTAGRAM_REDIRECT_URI = 'https://api.florrie.test/api/instagram/callback';
process.env.INSTAGRAM_VERIFY_TOKEN = 'verify-me';
process.env.FRONTEND_URL = 'https://florrie.test';
process.env.ANTHROPIC_API_KEY = 'sk-test';

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import { createServer } from 'http';
import crypto from 'crypto';

/* ------------------------------------------------------------------ schema --
 * Column lists copied from supabase/migrations. Only the tables this path
 * touches are enforced, so this file fails for these defects and nothing else.
 *
 *   beauticians    001_initial_schema, 021_instagram_columns,
 *                  032_instagram_dm_control, 038_instagram_page_name,
 *                  067_instagram_page_token_rename, docs/sql/20260709_voice_profile
 *   content_posts  001_initial_schema, 035_content_streams,
 *                  docs/sql/20260709_voice_profile (media_kind)
 *   clients        001_initial_schema, 021, 032,
 *                  20260727_backend016 (instagram_username)
 *   messages       001_initial_schema, 20260727_backend016 (is_junk),
 *                  20260805_message_authorship
 *
 * NOT present anywhere in supabase/migrations, deliberately:
 *   beauticians.instagram_account_ids
 *   content_posts.failure_reason
 * Both are proposed by this work and are handed over as SQL rather than as a
 * migration, so the default here is "column does not exist" and the code has
 * to cope. `applyProposedColumns()` flips the fake to the post migration world.
 */
const BASE_COLUMNS = {
  beauticians: [
    'id', 'auth_id', 'email', 'first_name', 'last_name', 'business_name', 'phone',
    'subscription_status', 'trial_ends_at', 'brand_color', 'brand_font', 'logo_url',
    'whatsapp_phone_id', 'whatsapp_token', 'google_place_id',
    'onboarding_completed_at', 'created_at', 'updated_at',
    'booking_slug', 'tone_model', 'confidence_threshold', 'auto_reply_enabled',
    'working_hours', 'calendar_settings', 'payment_settings',
    // 021_instagram_columns.sql
    'instagram_page_id', 'instagram_page_token',
    // 032_instagram_dm_control.sql
    'instagram_dm_mode', 'instagram_redirect_message',
    // 038_instagram_page_name.sql
    'instagram_page_name',
    // docs/sql/20260709_voice_profile.sql
    'voice_profile', 'voice_profile_updated_at',
  ],
  content_posts: [
    'id', 'beautician_id', 'image_url', 'caption', 'hashtags', 'platform',
    'post_type', 'status', 'approved_at', 'scheduled_for', 'posted_at',
    'likes', 'comments', 'shares', 'bookings_attributed', 'external_post_id',
    'created_at',
    // 035_content_streams.sql
    'stream_id',
    // docs/sql/20260709_voice_profile.sql
    'media_kind',
  ],
  clients: [
    'id', 'beautician_id', 'first_name', 'last_name', 'phone', 'email',
    'whatsapp_id', 'instagram_id', 'preferred_channel', 'status', 'created_at',
    // 032_instagram_dm_control.sql
    'instagram_redirect_sent_at',
    // 20260727_backend016_junk_flag_and_instagram_username.sql
    'instagram_username',
  ],
  messages: [
    'id', 'beautician_id', 'client_id', 'channel', 'direction', 'content',
    'external_message_id', 'whatsapp_message_id', 'ai_handled', 'escalated',
    'media_url', 'media_type', 'delivered_at', 'read_at', 'send_status',
    'created_at',
    // 20260727_backend016
    'is_junk', 'junk_reason',
    // 20260805_message_authorship.sql
    'authored_by', 'digital_employee',
  ],
  ai_actions: [
    'id', 'beautician_id', 'action_type', 'digital_employee', 'summary',
    'details', 'confidence', 'autonomous', 'client_id', 'appointment_id',
    'message_id', 'outcome', 'notification_sent', 'notification_text',
    'status', 'created_at',
  ],
};

// migration 051 kept the digital_employee allow-list. 'content_creator' is not
// on it, which is why plan-a-week never logged an action.
const DIGITAL_EMPLOYEES = ['front_desk', 'calendar', 'comeback', 'content', 'money', 'scout', 'marketing', 'general'];

let COLUMNS = {};
function resetSchema() {
  COLUMNS = Object.fromEntries(Object.entries(BASE_COLUMNS).map(([t, c]) => [t, [...c]]));
}
function applyProposedColumns() {
  COLUMNS.beauticians.push('instagram_account_ids', 'instagram_token_expires_at');
  COLUMNS.content_posts.push('failure_reason');
}
resetSchema();

const db = { beauticians: [], clients: [], messages: [], content_posts: [], ai_actions: [] };
let idCounter = 0;
const nextId = (p) => `${p}_${++idCounter}`;

const undefinedColumn = (table, col) => ({
  code: '42703',
  message: `column ${table}.${col} does not exist`,
  details: null,
  hint: null,
});
// What PostgREST answers when a WRITE names a column it does not know.
const unknownWriteColumn = (table, col) => ({
  code: 'PGRST204',
  message: `Could not find the '${col}' column of '${table}' in the schema cache`,
  details: null,
  hint: null,
});
const checkViolation = (constraint) => ({
  code: '23514',
  message: `new row violates check constraint "${constraint}"`,
  details: null,
  hint: null,
});

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
    if (col === '*') continue;
    if (!known.includes(col)) return undefinedColumn(table, col);
  }
  return null;
}

/** A write is rejected whole if any one column is unknown, exactly as PostgREST does. */
function parseWrite(table, payload) {
  const known = COLUMNS[table];
  if (!known) return null;
  for (const row of (Array.isArray(payload) ? payload : [payload])) {
    for (const col of Object.keys(row || {})) {
      if (!known.includes(col)) return unknownWriteColumn(table, col);
    }
    if (table === 'ai_actions' && row?.digital_employee && !DIGITAL_EMPLOYEES.includes(row.digital_employee)) {
      return checkViolation('ai_actions_digital_employee_check');
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
    if (pending?.op === 'delete') {
      const gone = matching();
      db[table] = (db[table] || []).filter(r => !filters.every(f => f(r)));
      return { data: gone, error: null, count: gone.length };
    }
    const rows = matching();
    return { data: rows.map(r => ({ ...r })), error: null, count: rows.length };
  };

  const b = {
    select(spec = '*') { selectError = parseSelect(table, spec); return b; },
    insert(p) { pending = { op: 'insert', payload: p }; writeError = parseWrite(table, p); return b; },
    update(p) { pending = { op: 'update', payload: p }; writeError = parseWrite(table, p); return b; },
    delete() { pending = { op: 'delete' }; return b; },
    eq(c, v) { filters.push(r => r[c] === v); return b; },
    neq(c, v) { filters.push(r => r[c] !== v); return b; },
    in(c, v) { filters.push(r => v.map(String).includes(String(r[c]))); return b; },
    is(c, v) { filters.push(r => (r[c] ?? null) === v); return b; },
    or() { return b; },
    not(c) { filters.push(r => (r[c] ?? null) !== null); return b; },
    // PostgREST's array overlap. Errors like any other filter when the column
    // is not in the schema cache, which is the case this file cares about.
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

/* ------------------------------------------------------------------- mocks -- */
const frontDeskCalls = [];
vi.mock('../../src/services/ai-front-desk.js', () => ({
  processInboundMessage: async (messageId, beautician) => {
    frontDeskCalls.push({ messageId, beauticianId: beautician.id });
    return { handled: true, intent: 'booking' };
  },
}));
vi.mock('../../src/services/push-notifications.js', () => ({ pushMessagesWaiting: async () => true }));
vi.mock('../../src/lib/client-archive.js', () => ({ autoUnarchiveClient: async () => true }));
vi.mock('@sentry/node', () => ({ captureMessage: () => {}, captureException: () => {} }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class { constructor() { this.messages = { create: async () => ({ content: [{ text: 'caption' }] }) }; } },
}));
vi.mock('../../src/middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.beautician = { id: currentBeauticianId }; next(); },
}));

let currentBeauticianId = 'b-ellie';

/* ------------------------------------------------------------------- fetch --
 * One stub for every outbound call. Requests to the local test server are
 * passed straight through to the real fetch, so the express routes can still
 * be exercised over HTTP.
 */
const realFetch = globalThis.fetch;
let graph = {};        // url matcher -> handler
const graphCalls = [];

function bodyOf(init) {
  const raw = init?.body;
  if (!raw) return null;
  if (typeof raw !== 'string') return String(raw);          // URLSearchParams, form encoded
  try { return JSON.parse(raw); } catch { return raw; }
}

function graphHandler(url, init) {
  graphCalls.push({ url, method: init?.method || 'GET', body: bodyOf(init), init });
  // Longest pattern first. `/{id}/media_publish` contains `/{id}/media`, so
  // insertion order would let the container stub answer the publish call, and
  // a test that thinks it proved the publish step would have proved nothing.
  const patterns = Object.keys(graph).sort((a, b) => b.length - a.length);
  for (const pattern of patterns) {
    if (url.includes(pattern)) return graph[pattern](url, init);
  }
  return { ok: false, status: 404, json: async () => ({ error: { message: `no stub for ${url}` } }) };
}

vi.stubGlobal('fetch', async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.includes('127.0.0.1') || url.includes('localhost')) return realFetch(input, init);
  const r = await graphHandler(url, init);
  return { ok: r.ok !== false, status: r.status || 200, json: async () => r.json ? r.json() : r.body };
});

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const fail = (status, error) => ({ ok: false, status, json: async () => ({ error }) });

/* ------------------------------------------------------------------ server -- */
const { default: instagramRouter } = await import('../../src/routes/instagram.js');
const { default: webhookRouter } = await import('../../src/routes/instagram-webhooks.js');
const { publishPost, imageUrlProblem, waitForContainer } = await import('../../src/services/content-autopilot.js');
const { publishScheduledPosts } = await import('../../src/services/content-scheduler.js');
const { signOAuthState } = await import('../../src/lib/oauth-state.js');

const app = express();
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));
app.use('/api/instagram', instagramRouter);
app.use('/api/webhooks/instagram', webhookRouter);
const server = createServer(app);
await new Promise(r => server.listen(0, r));
const PORT = server.address().port;
const base = `http://127.0.0.1:${PORT}`;

const get = (path) => realFetch(`${base}${path}`, { redirect: 'manual' })
  .then(async r => ({ status: r.status, location: r.headers.get('location'), body: await r.json().catch(() => ({})) }));

async function postWebhook(payload) {
  const raw = JSON.stringify(payload);
  const sig = 'sha256=' + crypto.createHmac('sha256', process.env.INSTAGRAM_APP_SECRET).update(raw).digest('hex');
  const r = await realFetch(`${base}/api/webhooks/instagram`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': sig },
    body: raw,
  });
  // The route answers 200 before it processes, so give the async half a tick.
  await new Promise(res => setTimeout(res, 30));
  return r.status;
}

/* ---------------------------------------------------------------- fixtures --
 * The two ids Instagram hands back for the SAME account. Not equal, which is
 * the whole problem.
 */
const IG_USER_ID = '17841400000000001';   // /me?fields=user_id  -> user_id
const IG_APP_SCOPED_ID = '9876543210';     // /me                -> id
const SENDER_IGSID = '6543210987654321';

function seedConnected(over = {}) {
  db.beauticians = [{
    id: 'b-ellie',
    first_name: 'Ellie',
    business_name: 'Ellindigo',
    phone: '07700900123',
    instagram_page_id: IG_USER_ID,
    instagram_page_token: 'IGQVJ-long-lived',
    instagram_page_name: 'ellindigo',
    instagram_dm_mode: 'ai',
    auto_reply_enabled: false,
    ...over,
  }];
}

beforeEach(() => {
  resetSchema();
  for (const k of Object.keys(db)) db[k] = [];
  logs.warn.length = 0; logs.error.length = 0; logs.info.length = 0;
  frontDeskCalls.length = 0;
  graphCalls.length = 0;
  graph = {};
  currentBeauticianId = 'b-ellie';
  idCounter = 0;
});

/* ===========================================================================
 * VIDEO 1, STEP 1: connecting the account
 * ======================================================================== */
describe('connect: every id the login reports is kept, not one guess', () => {
  function stubHappyOAuth({ username = 'ellindigo' } = {}) {
    graph['api.instagram.com/oauth/access_token'] = () => ok({ access_token: 'short-tok', user_id: IG_APP_SCOPED_ID });
    graph['graph.instagram.com/access_token'] = () => ok({ access_token: 'long-tok', expires_in: 5183944 });
    // The shape that caused the outage: /me answers with a user_id that is NOT
    // the user_id the token exchange returned, plus an `id` that is a third
    // value again.
    graph['graph.instagram.com/v21.0/me?fields=user_id%2Cusername%2Cname'] =
      () => ok({ user_id: IG_USER_ID, id: IG_APP_SCOPED_ID, username, name: 'Ellindigo Beauty' });
    graph['me/subscribed_apps'] = () => ok({ success: true });
  }

  async function runCallback() {
    db.beauticians = [{ id: 'b-ellie', first_name: 'Ellie' }];
    const state = signOAuthState({ beauticianId: 'b-ellie' });
    return get(`/api/instagram/callback?code=abc123&state=${encodeURIComponent(state)}`);
  }

  it('stores the id, the token and the real @handle', async () => {
    applyProposedColumns();
    stubHappyOAuth();
    const res = await runCallback();

    expect(res.status).toBe(302);
    expect(res.location).toContain('ig=success');

    const row = db.beauticians[0];
    expect(row.instagram_page_token).toBe('long-tok');
    expect(row.instagram_page_id).toBe(IG_USER_ID);
    // The handle, not the literal word Instagram.
    expect(row.instagram_page_name).toBe('ellindigo');
  });

  it('records when the token expires, so the health check can warn first', async () => {
    // lib/health.js has always READ instagram_token_expires_at and warned on
    // anything close to it. Nothing ever wrote it, so that warning had never
    // fired in its life. expires_in is only visible here, at the exchange.
    applyProposedColumns();
    stubHappyOAuth();
    graph['graph.instagram.com/access_token'] = () => ok({ access_token: 'long-tok', expires_in: 5183944 });
    await runCallback();

    const at = Date.parse(db.beauticians[0].instagram_token_expires_at);
    const days = (at - Date.now()) / 86400000;
    expect(days).toBeGreaterThan(55);
    expect(days).toBeLessThan(61);
  });

  it('keeps BOTH ids Instagram reported, because they are different numbers', async () => {
    applyProposedColumns();
    stubHappyOAuth();
    await runCallback();

    const ids = db.beauticians[0].instagram_account_ids;
    expect(ids).toContain(IG_USER_ID);
    expect(ids).toContain(IG_APP_SCOPED_ID);
    // Which is the point: betting on either one alone is a coin flip.
    expect(IG_USER_ID).not.toBe(IG_APP_SCOPED_ID);
  });

  it('still saves the token when instagram_account_ids does not exist yet', async () => {
    // No applyProposedColumns(). PostgREST rejects the whole write on an
    // unknown column, so folding the id list into the main patch would have
    // meant a missing migration silently produced a connection with no token.
    stubHappyOAuth();
    const res = await runCallback();

    expect(res.location).toContain('ig=success');
    expect(db.beauticians[0].instagram_page_token).toBe('long-tok');
    expect(db.beauticians[0].instagram_page_id).toBe(IG_USER_ID);
    expect(logs.warn.some(l => /instagram_account_ids/.test(l.msg || ''))).toBe(true);
  });

  it('never writes the literal string "Instagram" as the page name', async () => {
    applyProposedColumns();
    stubHappyOAuth({ username: '' });
    // Every field list comes back handle-less.
    graph['graph.instagram.com/v21.0/me'] = () => ok({ user_id: IG_USER_ID });
    await runCallback();

    // The Settings card reads this. "Connected, Instagram" is what a Meta
    // reviewer reads as an unconnected account.
    expect(db.beauticians[0].instagram_page_name).not.toBe('Instagram');
    expect(db.beauticians[0].instagram_page_name ?? null).toBeNull();
  });

  it('a reconnect that cannot read the handle does not wipe the one on file', async () => {
    applyProposedColumns();
    seedConnected({ instagram_page_name: 'ellindigo' });
    graph['api.instagram.com/oauth/access_token'] = () => ok({ access_token: 'short-2', user_id: IG_APP_SCOPED_ID });
    graph['graph.instagram.com/access_token'] = () => ok({ access_token: 'long-2' });
    graph['graph.instagram.com/v21.0/me'] = () => ok({ user_id: IG_USER_ID });
    graph['me/subscribed_apps'] = () => ok({ success: true });

    const state = signOAuthState({ beauticianId: 'b-ellie' });
    await get(`/api/instagram/callback?code=xyz&state=${encodeURIComponent(state)}`);

    expect(db.beauticians[0].instagram_page_token).toBe('long-2');
    expect(db.beauticians[0].instagram_page_name).toBe('ellindigo');
  });

  it('retries the handle with a shorter field list when the rich one is refused', async () => {
    applyProposedColumns();
    graph['api.instagram.com/oauth/access_token'] = () => ok({ access_token: 'short-tok', user_id: IG_APP_SCOPED_ID });
    graph['graph.instagram.com/access_token'] = () => ok({ access_token: 'long-tok' });
    // Asking for username alongside other fields 400s on some accounts, which
    // is how the handle went missing in the first place.
    graph['fields=user_id%2Cusername%2Cname'] = () => fail(400, { message: 'username is not available for this account' });
    graph['fields=user_id%2Cusername'] = () => fail(400, { message: 'username is not available for this account' });
    graph['fields=username'] = () => ok({ username: '@ellindigo' });
    graph['fields=user_id'] = () => ok({ user_id: IG_USER_ID });
    graph['me/subscribed_apps'] = () => ok({ success: true });

    await runCallback();
    // Stored bare, so a lookup and the display agree.
    expect(db.beauticians[0].instagram_page_name).toBe('ellindigo');
  });
});

/* ===========================================================================
 * VIDEO 1, STEP 2: the Settings card
 * ======================================================================== */
describe('status: the card tells the truth about the token and the handle', () => {
  it('reports needs_reconnect when Instagram rejects the token', async () => {
    seedConnected();
    graph['graph.instagram.com/v21.0/me'] = () => fail(401, { message: 'Error validating access token: Session has expired', code: 190 });

    const res = await get('/api/instagram/status');
    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(true);       // an id is on file
    expect(res.body.token_valid).toBe(false);
    expect(res.body.needs_reconnect).toBe(true); // and this is what the card reads
  });

  it('repairs a page name of "Instagram" from the live handle', async () => {
    seedConnected({ instagram_page_name: 'Instagram' });
    graph['graph.instagram.com/v21.0/me'] = () => ok({ user_id: IG_USER_ID, username: 'ellindigo' });

    const res = await get('/api/instagram/status');
    expect(res.body.needs_reconnect).toBe(false);
    expect(res.body.page_name).toBe('ellindigo');
    // And it is fixed on the row, so it stays fixed.
    expect(db.beauticians[0].instagram_page_name).toBe('ellindigo');
  });

  it('says whether the account is actually subscribed to message webhooks', async () => {
    // A live token and a stored id prove she connected. Neither proves Meta
    // will deliver a single DM: that is a separate POST at connect time which
    // is non-fatal when it fails. This is the only thing that catches it
    // before a recording session sends a test DM and waits for nothing.
    seedConnected();
    graph['me/subscribed_apps'] = () => ok({ data: [{ subscribed_fields: [{ name: 'messages' }] }] });
    graph['graph.instagram.com/v21.0/me?fields=user_id,username'] = () => ok({ user_id: IG_USER_ID, username: 'ellindigo' });
    let res = await get('/api/instagram/status');
    expect(res.body.webhook_subscribed).toBe(true);

    graph['me/subscribed_apps'] = () => ok({ data: [] });
    res = await get('/api/instagram/status');
    expect(res.body.webhook_subscribed).toBe(false);
    // Still connected: an unsubscribed account is not a dead token.
    expect(res.body.needs_reconnect).toBe(false);
  });

  it('never invents a name when the handle is genuinely unknown', async () => {
    seedConnected({ instagram_page_name: 'Instagram' });
    graph['graph.instagram.com/v21.0/me'] = () => ok({ user_id: IG_USER_ID });

    const res = await get('/api/instagram/status');
    expect(res.body.page_name).toBeNull();
  });
});

/* ===========================================================================
 * VIDEO 1, STEP 3: the DM has to reach the right salon
 * ======================================================================== */
describe('webhook: routing cannot be wrong, and is never guessed', () => {
  const dm = (entryId, recipientId, text = 'Hiya, do you have Friday free for a lash lift?') => ({
    object: 'instagram',
    entry: [{
      id: entryId,
      time: Date.now(),
      messaging: [{
        sender: { id: SENDER_IGSID },
        recipient: { id: recipientId },
        timestamp: Date.now(),
        message: { mid: 'mid.abc', text },
      }],
    }],
  });

  beforeEach(() => {
    // Identity lookups for the new client. Harmless if unused.
    graph[`graph.instagram.com/v21.0/${SENDER_IGSID}`] = () => ok({ name: 'Sophie', username: 'sophie.b' });
    graph['me/messages'] = () => ok({ message_id: 'mid.out' });
  });

  it('routes on instagram_page_id, the ordinary case', async () => {
    seedConnected();
    expect(await postWebhook(dm(IG_USER_ID, IG_USER_ID))).toBe(200);

    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].beautician_id).toBe('b-ellie');
    expect(db.messages[0].channel).toBe('instagram');
    expect(db.messages[0].direction).toBe('inbound');
  });

  it('routes when entry.id is the OTHER id, the one we did not make primary', async () => {
    applyProposedColumns();
    seedConnected({ instagram_account_ids: [IG_USER_ID, IG_APP_SCOPED_ID] });

    // This is the production outage exactly: Meta sends the app scoped id,
    // instagram_page_id holds the user_id, and the old code dropped the DM.
    expect(await postWebhook(dm(IG_APP_SCOPED_ID, IG_APP_SCOPED_ID))).toBe(200);

    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].beautician_id).toBe('b-ellie');
  });

  it('routes on recipient.id when entry.id is one we have never seen', async () => {
    seedConnected();
    // Meta's webhook reference describes entry.id only as "the object's ID"
    // and points at recipient.id for the professional account, so both are
    // tried before anything is dropped.
    expect(await postWebhook(dm('0000000000', IG_USER_ID))).toBe(200);
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].beautician_id).toBe('b-ellie');
  });

  it('drops an unmatched delivery and never hands it to an arbitrary salon', async () => {
    // Two tenants. The old ".limit(1).single()" fallback handed the DM to
    // whichever row came back first.
    db.beauticians = [
      { id: 'b-someone-else', first_name: 'Priya', instagram_page_id: '111', instagram_page_token: 't1', instagram_dm_mode: 'ai' },
      { id: 'b-another', first_name: 'Dee', instagram_page_id: '222', instagram_page_token: 't2', instagram_dm_mode: 'ai' },
    ];

    expect(await postWebhook(dm('999', '999'))).toBe(200);

    expect(db.messages).toHaveLength(0);
    expect(frontDeskCalls).toHaveLength(0);
    // And the ids are logged, so a mis-stored row can be corrected without
    // guessing at what Meta is actually sending.
    const dropped = logs.warn.find(l => /no beautician matches/i.test(l.msg || ''));
    expect(dropped).toBeTruthy();
    expect(dropped.ctx.candidateIds).toContain('999');
  });

  it('an errored lookup is reported as an error, not as an unknown account', async () => {
    // instagram_account_ids missing is the default here, so the fallback query
    // errors. That must not read as "this DM belongs to nobody".
    seedConnected();
    expect(await postWebhook(dm(IG_USER_ID, IG_USER_ID))).toBe(200);
    expect(db.messages).toHaveLength(1);   // primary lookup still answered

    // And when nothing matches at all, the column problem is said out loud.
    db.messages.length = 0;
    logs.warn.length = 0;
    await postWebhook(dm('unknown-id', 'unknown-id'));
    expect(logs.warn.some(l => /instagram_account_ids/.test(l.msg || ''))).toBe(true);
  });

  it('hands the DM to the front desk with the sender @handle captured', async () => {
    seedConnected();
    await postWebhook(dm(IG_USER_ID, IG_USER_ID));

    expect(frontDeskCalls).toHaveLength(1);
    expect(frontDeskCalls[0].beauticianId).toBe('b-ellie');
    const client = db.clients[0];
    expect(client.instagram_id).toBe(SENDER_IGSID);
    // The Inbox row shows this. "Instagram User" with no handle is what a
    // reviewer sees as a broken integration.
    expect(client.instagram_username).toBe('sophie.b');
    expect(client.first_name).toBe('Sophie');
  });
});

/* ===========================================================================
 * VIDEO 2: the post has to reach the profile
 * ======================================================================== */
describe('publish: the two step flow, done in the documented order', () => {
  const PUBLIC_IMG = 'https://xyz.supabase.co/storage/v1/object/public/content-images/b-ellie/1.jpg';

  function seedDraft(over = {}) {
    db.content_posts = [{
      id: 'post-1',
      beautician_id: 'b-ellie',
      caption: 'Fresh set of lashes on Sophie today.',
      hashtags: ['#lashlift', '#brows'],
      image_url: PUBLIC_IMG,
      platform: 'instagram',
      post_type: 'before_after',
      status: 'draft',
      ...over,
    }];
  }

  it('refuses a signed storage url before it creates anything', () => {
    // Instagram fetches the image server side, with none of our session, so a
    // signed link is a guaranteed failure several seconds after the tap.
    const signed = 'https://xyz.supabase.co/storage/v1/object/sign/content-images/b-ellie/1.jpg?token=eyJhbGciOi';
    expect(imageUrlProblem(signed)).toMatch(/signed/i);
    expect(imageUrlProblem('blob:https://florrie.test/9c1')).toBeTruthy();
    expect(imageUrlProblem('http://localhost:5173/x.jpg')).toMatch(/public link/i);
    expect(imageUrlProblem('')).toMatch(/no photo/i);
    // And the one that must pass.
    expect(imageUrlProblem(PUBLIC_IMG)).toBeNull();
  });

  it('does not create a container for an unreachable image, and says why', async () => {
    seedConnected();
    seedDraft({ image_url: 'https://xyz.supabase.co/storage/v1/object/sign/x.jpg?token=abc' });

    const result = await publishPost('b-ellie', 'post-1');

    expect(result.published).toBe(false);
    expect(result.reason).toMatch(/signed/i);
    expect(graphCalls.filter(c => c.url.includes('/media'))).toHaveLength(0);
    expect(db.content_posts[0].status).toBe('failed');
  });

  it('polls the container and publishes only once it is FINISHED', async () => {
    seedConnected();
    seedDraft();
    let polls = 0;
    graph[`${IG_USER_ID}/media`] = () => ok({ id: 'container-1' });
    graph['graph.instagram.com/v21.0/container-1'] = () => {
      polls += 1;
      return ok({ status_code: polls < 2 ? 'IN_PROGRESS' : 'FINISHED' });
    };
    graph[`${IG_USER_ID}/media_publish`] = () => ok({ id: 'ig-post-77' });

    const result = await publishPost('b-ellie', 'post-1');

    expect(polls).toBeGreaterThanOrEqual(2);
    expect(result).toEqual({ published: true, instagramId: 'ig-post-77' });
    expect(db.content_posts[0].status).toBe('posted');
    expect(db.content_posts[0].external_post_id).toBe('ig-post-77');

    // Order matters: the publish must come after a FINISHED read.
    const seq = graphCalls.map(c => c.url);
    const created = seq.findIndex(u => u.endsWith('/media'));
    const publishedAt = seq.findIndex(u => u.includes('/media_publish'));
    const polled = seq.findIndex(u => u.includes('container-1?fields=status_code'));
    expect(created).toBeLessThan(polled);
    expect(polled).toBeLessThan(publishedAt);
  });

  it('never marks a post published when the container ends in ERROR', async () => {
    seedConnected();
    seedDraft();
    graph[`${IG_USER_ID}/media`] = () => ok({ id: 'container-2' });
    graph['graph.instagram.com/v21.0/container-2'] = () => ok({ status_code: 'ERROR', status: 'Media download failed' });

    const result = await publishPost('b-ellie', 'post-1');

    expect(result.published).toBe(false);
    expect(result.reason).toMatch(/download failed/i);
    expect(db.content_posts[0].status).toBe('failed');
    expect(db.content_posts[0].posted_at).toBeUndefined();
    // The publish call must never have happened.
    expect(graphCalls.some(c => c.url.includes('media_publish'))).toBe(false);
  });

  it('never marks a post published when media_publish is rejected', async () => {
    // This is the exact defect: the old code read neither the status nor the
    // id and wrote status 'posted' with external_post_id undefined.
    seedConnected();
    seedDraft();
    graph[`${IG_USER_ID}/media`] = () => ok({ id: 'container-3' });
    graph['graph.instagram.com/v21.0/container-3'] = () => ok({ status_code: 'FINISHED' });
    graph[`${IG_USER_ID}/media_publish`] = () => fail(400, { message: 'The user is not an Instagram Business account' });

    const result = await publishPost('b-ellie', 'post-1');

    expect(result.published).toBe(false);
    expect(result.reason).toMatch(/Business account/);
    expect(db.content_posts[0].status).toBe('failed');
    expect(db.content_posts[0].external_post_id).toBeUndefined();
  });

  it('publishes against /me when the stored account id is the wrong one', async () => {
    // The same id disagreement that broke DM routing also breaks publishing,
    // and `me` resolves to whoever the token belongs to, so it cannot be wrong.
    seedConnected({ instagram_page_id: 'a-wrong-id' });
    seedDraft();
    graph['a-wrong-id/media'] = () => fail(400, { message: 'Unsupported get request. Object with ID does not exist' });
    graph['me/media'] = () => ok({ id: 'container-4' });
    graph['graph.instagram.com/v21.0/container-4'] = () => ok({ status_code: 'FINISHED' });
    graph['me/media_publish'] = () => ok({ id: 'ig-post-99' });

    const result = await publishPost('b-ellie', 'post-1');

    expect(result.published).toBe(true);
    expect(db.content_posts[0].status).toBe('posted');
    expect(logs.warn.some(l => /stored instagram_page_id was rejected/i.test(l.msg || ''))).toBe(true);
  });

  it('saves the failure reason when the column is there, and survives when it is not', async () => {
    seedConnected();
    seedDraft();
    graph[`${IG_USER_ID}/media`] = () => fail(400, { message: 'Invalid image URL' });
    graph['me/media'] = () => fail(400, { message: 'Invalid image URL' });

    // Without the column: status still has to land.
    await publishPost('b-ellie', 'post-1');
    expect(db.content_posts[0].status).toBe('failed');
    expect(logs.warn.some(l => /failure_reason/.test(l.msg || ''))).toBe(true);

    // With it: the reason is stored for the UI.
    applyProposedColumns();
    db.content_posts[0].status = 'draft';
    await publishPost('b-ellie', 'post-1');
    expect(db.content_posts[0].status).toBe('failed');
    expect(db.content_posts[0].failure_reason).toMatch(/Invalid image URL/);
  });

  it('waitForContainer gives up rather than hanging the request forever', async () => {
    graph['graph.instagram.com/v21.0/container-x'] = () => ok({ status_code: 'IN_PROGRESS' });
    const r = await waitForContainer('container-x', 'tok', { attempts: 3, delayMs: 0, sleep: async () => {} });
    expect(r.ok).toBe(false);
    expect(r.statusCode).toBe('TIMEOUT');
  });
});

/* ===========================================================================
 * The scheduled path, same publish, unattended
 * ======================================================================== */
describe('scheduler: a scheduled post that did not go out says so', () => {
  it('marks a scheduled post failed when Instagram is not connected', async () => {
    applyProposedColumns();
    db.beauticians = [{ id: 'b-ellie', first_name: 'Ellie' }];   // no token
    db.content_posts = [{
      id: 'post-s', beautician_id: 'b-ellie', status: 'scheduled',
      scheduled_for: '2020-01-01T00:00:00.000Z',
      image_url: 'https://cdn.florrie.test/a.jpg', caption: 'x', platform: 'instagram',
    }];

    const out = await publishScheduledPosts();

    expect(out.published).toBe(0);
    expect(out.failed).toBe(1);
    // Not left sitting in 'approved', where it appears nowhere and nobody
    // ever learns the post never happened.
    expect(db.content_posts[0].status).toBe('failed');
    expect(db.content_posts[0].failure_reason).toMatch(/not connected/i);
  });

  it('returns a photoless scheduled post to drafts rather than failing it', async () => {
    seedConnected();
    db.content_posts = [{
      id: 'post-n', beautician_id: 'b-ellie', status: 'scheduled',
      scheduled_for: '2020-01-01T00:00:00.000Z', image_url: null,
      caption: 'x', platform: 'instagram',
    }];

    await publishScheduledPosts();
    expect(db.content_posts[0].status).toBe('draft');
  });
});

/* ===========================================================================
 * Column truth for the rows this path writes
 * ======================================================================== */
describe('column truth', () => {
  it('the fake rejects a column that is not in the migrations, as PostgREST does', async () => {
    const { supabase } = await import('../../src/config.js');
    const { error } = await supabase.from('beauticians').select('instagram_page_id, instagram_handle').eq('id', 'x');
    expect(error?.code).toBe('42703');
    expect(error?.message).toMatch(/instagram_handle/);
  });

  it('plan-a-week logs against a digital_employee the CHECK constraint allows', async () => {
    // 'content_creator' is not in migration 051's allow-list, so every run
    // silently logged nothing at all. The fake enforces the constraint.
    const { supabase } = await import('../../src/config.js');
    const bad = await supabase.from('ai_actions').insert({
      beautician_id: 'b-ellie', action_type: 'content_drafted',
      digital_employee: 'content_creator', summary: 'x',
    });
    expect(bad.error?.code).toBe('23514');

    const good = await supabase.from('ai_actions').insert({
      beautician_id: 'b-ellie', action_type: 'content_drafted',
      digital_employee: 'content', summary: 'x',
    });
    expect(good.error).toBeNull();

    const src = await import('node:fs').then(fs => fs.readFileSync(
      new URL('../../src/services/content-autopilot.js', import.meta.url), 'utf8'));
    expect(src).not.toMatch(/digital_employee: 'content_creator'/);
  });

  it('the webhook has no single-tenant fallback left in it', async () => {
    const raw = await import('node:fs').then(fs => fs.readFileSync(
      new URL('../../src/routes/instagram-webhooks.js', import.meta.url), 'utf8'));
    // Comments stripped, because the file explains the old bug by name and the
    // explanation is not the bug.
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    // The shape of it: take the first beautician in the table and call it the
    // recipient of whatever just arrived.
    expect(src).not.toMatch(/\.limit\(1\)\s*\.single\(\)/);
    expect(src).not.toMatch(/from\('beauticians'\)[\s\S]{0,200}?\.limit\(1\)\s*\.single\(\)/);
  });
});
