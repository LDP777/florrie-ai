#!/usr/bin/env node
/**
 * Meta App Review rehearsal, Instagram permissions.
 *
 * Proves as much of the recording-day chain as can be proved without sending
 * a real DM and without publishing anything. Run it against PRODUCTION, from
 * the operator's own machine, immediately before recording.
 *
 * WHAT IT NEEDS
 *   The Florrie login for the account being recorded. Nothing else. The
 *   Supabase URL and anon key are public client config and are baked in as
 *   defaults, exactly as they ship in the web bundle.
 *
 * HOW TO RUN
 *   node docs/meta-review-rehearsal.mjs
 *
 *   FLORRIE_EMAIL=ellie@example.com \
 *   FLORRIE_PASSWORD='...' \
 *   node docs/meta-review-rehearsal.mjs
 *
 *   Or, if you would rather not put the password on a command line, copy the
 *   access token out of the browser (DevTools, Application, Local Storage,
 *   the sb-<project>-auth-token key, the access_token field) and pass:
 *
 *   FLORRIE_TOKEN='eyJ...' node docs/meta-review-rehearsal.mjs
 *
 *   With no environment set at all it prompts for the email and password on
 *   the terminal, with the password hidden.
 *
 * FLAGS
 *   --no-container   Skip the live media container dry run. Use this if you
 *                    would rather nothing at all touched the Instagram
 *                    account. The dry run never publishes: it creates a
 *                    container, reads its status, and stops. An unpublished
 *                    container expires on its own within 24 hours.
 *   --json           Machine-readable output as well as the human report.
 *   --help
 *
 * ENVIRONMENT OVERRIDES
 *   API_BASE         Default https://florriebackend-production.up.railway.app
 *                    which is the host the shipped web and iOS bundles call.
 *                    Set this to https://api.florrie.ai to test that alias.
 *   SUPABASE_URL, SUPABASE_ANON_KEY
 *
 * NODE
 *   Node 18 or newer. No dependencies, no install step.
 *
 * WHAT IT CANNOT PROVE
 *   Whether Ellie's Instagram account has accepted the app tester invite.
 *   Whether an inbound DM actually routes (that needs a real DM).
 *   Whether the redirect URI registered in the Meta dashboard matches ours
 *   character for character (it prints ours so you can compare by eye).
 *   Whether the device you record on is running a current frontend build.
 *
 * NOT TESTED END TO END BY THE AUTHOR. The environment this was written in
 * has no network route to Supabase or to the API host, so no check in this
 * file has been executed against the live services. Every request shape is
 * taken from the application source it mirrors. Treat the first run as part
 * of the rehearsal: if a check fails in a way that looks like a bug in this
 * script rather than a real problem, read the raw error it prints and judge
 * it on that.
 */

const args = new Set(process.argv.slice(2));

const SKIP_CONTAINER = args.has('--no-container');
const AS_JSON = args.has('--json');

const API_BASE = (process.env.API_BASE || 'https://florriebackend-production.up.railway.app').replace(/\/+$/, '');
const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://driyreevwogxngqyshtc.supabase.co').replace(/\/+$/, '');
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRyaXlyZWV2d29neG5ncXlzaHRjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQyOTk1NzgsImV4cCI6MjA4OTg3NTU3OH0.QgaZqyedVckQTZeTvArPBJUpa8MNb-mN8kBlSVqU2hQ';

const REQUIRED_SCOPES = [
  'instagram_business_basic',
  'instagram_business_manage_messages',
  'instagram_business_content_publish',
];

if (args.has('--help') || args.has('-h')) {
  console.log(`Meta App Review rehearsal for Instagram.

  node docs/meta-review-rehearsal.mjs [--no-container] [--json]

  FLORRIE_EMAIL / FLORRIE_PASSWORD, or FLORRIE_TOKEN, or answer the prompts.
  API_BASE defaults to ${API_BASE}
  Read the comment block at the top of this file for the full story.`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const results = [];
let sectionName = '';

function section(name) {
  sectionName = name;
  console.log(`\n\x1b[1m${name}\x1b[0m`);
  console.log('-'.repeat(Math.max(name.length, 40)));
}

function record(status, title, detail, fix) {
  results.push({ section: sectionName, status, title, detail, fix });
  const tag = status === 'PASS' ? '\x1b[32mPASS\x1b[0m'
    : status === 'FAIL' ? '\x1b[31mFAIL\x1b[0m'
    : status === 'WARN' ? '\x1b[33mWARN\x1b[0m'
    : '\x1b[90mSKIP\x1b[0m';
  console.log(`  [${tag}] ${title}`);
  if (detail) console.log(`         ${detail}`);
  if (fix && status !== 'PASS') console.log(`         \x1b[36mFix:\x1b[0m ${fix}`);
}

const pass = (t, d) => record('PASS', t, d);
const fail = (t, d, f) => record('FAIL', t, d, f);
const warn = (t, d, f) => record('WARN', t, d, f);
const skip = (t, d) => record('SKIP', t, d);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

async function jsonFetch(url, opts = {}, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { _raw: text.slice(0, 400) }; }
    return { ok: res.ok, status: res.status, body, headers: res.headers };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: null,
      error: err && err.name === 'AbortError' ? 'timed out' : String((err && err.message) || err),
    };
  } finally {
    clearTimeout(t);
  }
}

// Written as character codes rather than literals so no invisible control
// character ever ends up sitting in this file.
const CTRL_C = String.fromCharCode(3);
const CTRL_D = String.fromCharCode(4);
const BACKSPACE = String.fromCharCode(127);
const BACKSPACE_ALT = String.fromCharCode(8);

function prompt(question, hidden = false) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    if (!hidden) {
      stdin.resume();
      stdin.setEncoding('utf8');
      stdin.once('data', (d) => { stdin.pause(); resolve(String(d).trim()); });
      return;
    }
    let value = '';
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (ch) => {
      if (ch === '\n' || ch === '\r' || ch === CTRL_D) {
        if (stdin.isTTY) stdin.setRawMode(Boolean(wasRaw));
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(value);
        return;
      }
      if (ch === CTRL_C) { process.stdout.write('\n'); process.exit(130); }
      if (ch === BACKSPACE || ch === BACKSPACE_ALT) { value = value.slice(0, -1); return; }
      value += ch;
    };
    stdin.on('data', onData);
  });
}

/**
 * The same rules imageUrlProblem() applies in
 * backend/src/services/content-autopilot.js, so this script rejects the same
 * URLs the publish path would reject, for the same reasons.
 */
function imageUrlProblem(imageUrl) {
  const raw = String(imageUrl || '').trim();
  if (!raw) return 'The draft has no photo attached, so Instagram would have nothing to publish.';
  let u;
  try { u = new URL(raw); } catch { return 'The photo link on this draft is not a valid web address.'; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return 'The photo link is a blob: or data: URL, which only exists inside a browser. Instagram cannot fetch it.';
  }
  const host = u.hostname.toLowerCase();
  const privateHost = host === 'localhost' || host.endsWith('.local')
    || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host === '::1';
  if (privateHost) return 'The photo is on an address only our own server can reach. Instagram fetches the image itself.';
  if (/\/object\/sign\//.test(u.pathname) || u.searchParams.has('token')) {
    return 'The photo link is a private, signed link that expires. Instagram cannot use one. The content-images bucket needs to be public.';
  }
  return null;
}

function isPlaceholderHandle(name) {
  const n = String(name || '').trim().toLowerCase();
  return !n || n === 'instagram' || n === 'instagram user';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Sign in
// ---------------------------------------------------------------------------

async function getAccessToken() {
  if (process.env.FLORRIE_TOKEN) return process.env.FLORRIE_TOKEN.trim();

  let email = process.env.FLORRIE_EMAIL;
  let password = process.env.FLORRIE_PASSWORD;
  if (!email) email = await prompt('Florrie email (the account being recorded): ');
  if (!password) password = await prompt('Florrie password (hidden): ', true);

  const res = await jsonFetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok || !res.body || !res.body.access_token) {
    const why = (res.body && (res.body.error_description || res.body.msg || res.body.error))
      || res.error || `HTTP ${res.status}`;
    console.error('\n\x1b[31mCould not sign in to Florrie.\x1b[0m');
    console.error(`  ${why}`);
    console.error('  Fix: check the email and password, or paste an access token as FLORRIE_TOKEN.');
    console.error('  If the account has two-factor turned on, use FLORRIE_TOKEN instead.');
    process.exit(2);
  }
  return res.body.access_token;
}

// ---------------------------------------------------------------------------
// Supabase REST
// ---------------------------------------------------------------------------

function sbHeaders(token) {
  return { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}`, Accept: 'application/json' };
}

/**
 * Ask PostgREST for one column. A missing column comes back as HTTP 400 with
 * Postgres code 42703, which is exactly the signal we want: it means the
 * launch-sweep SQL has not been run.
 */
async function columnExists(token, table, column) {
  const res = await jsonFetch(
    `${SUPABASE_URL}/rest/v1/${table}?select=${encodeURIComponent(column)}&limit=1`,
    { headers: sbHeaders(token) },
  );
  if (res.ok) return { exists: true };
  const code = (res.body && res.body.code) || '';
  const msg = (res.body && res.body.message) || res.error || `HTTP ${res.status}`;
  if (code === '42703' || /does not exist/i.test(msg)) return { exists: false, msg };
  return { exists: null, msg };
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

async function main() {
  console.log('\x1b[1mMeta App Review rehearsal, Instagram\x1b[0m');
  console.log(`API:      ${API_BASE}`);
  console.log(`Supabase: ${SUPABASE_URL}`);
  console.log(`Container dry run: ${SKIP_CONTAINER ? 'skipped by flag' : 'on (creates a container, never publishes)'}`);

  const token = await getAccessToken();
  const auth = { Authorization: `Bearer ${token}` };
  const state = {};

  // ------------------------------------------------------------ 1. API up
  section('1. Is the API up, and is it the new build');

  const live = await jsonFetch(`${API_BASE}/health/live`);
  if (live.ok && live.body && live.body.status === 'alive') {
    pass('The API answers its liveness probe.');
  } else {
    fail('The API is not answering.',
      live.error || `HTTP ${live.status}`,
      `Check the Railway service is running and that API_BASE is right. It is currently ${API_BASE}. Nothing below this line can be trusted until this passes.`);
    return finish();
  }

  const health = await jsonFetch(`${API_BASE}/health`, {}, 30000);
  const igCheck = health.body && health.body.checks && health.body.checks.instagram_tokens;
  if (health.body && health.body.status === 'ok') {
    pass('Every health check is green.');
  } else if (health.body && health.body.status === 'degraded') {
    fail('The API reports itself degraded.',
      `Failing: ${(health.body.failing || []).join(', ') || 'unknown'}. Warnings: ${(health.body.warnings || []).join(', ') || 'none'}.`,
      'Read the checks object in the /health response. A degraded API means something critical is down. Do not record over the top of it.');
  } else {
    warn('Could not read the health summary.', health.error || `HTTP ${health.status}`,
      'Not fatal on its own, but worth a look before you commit to a recording session.');
  }

  if (igCheck) {
    const bits = [];
    if (igCheck.connected_accounts != null) bits.push(`${igCheck.connected_accounts} connected`);
    if (igCheck.invalid) bits.push(`${igCheck.invalid} with no token`);
    if (igCheck.disconnected_but_expected) bits.push(`${igCheck.disconnected_but_expected} expecting Instagram with nothing connected`);
    if (igCheck.status === 'ok') {
      pass('The Instagram health check is clean.', bits.join(', ') || undefined);
    } else {
      warn(`The Instagram health check says "${igCheck.status}".`,
        igCheck.detail || bits.join(', '),
        'If it names accounts expecting Instagram with nothing connected, those may be other rows on the same table, not the account you are recording. Section 3 below tells you about this account specifically.');
    }
    if (igCheck.expiry_tracked === false) {
      warn('The token expiry column is missing.',
        'health.js fell back to its shorter query, which means beauticians.instagram_token_expires_at is not there.',
        'Run docs/SQL_2026-08-23_LAUNCH_SWEEP.sql. Harmless for the recording itself, since the token will be hours old.');
    }
  }

  const connectCheck = await jsonFetch(`${API_BASE}/api/instagram/connect-check`, { headers: auth });
  if (connectCheck.status === 404) {
    fail('This API build predates the Instagram hardening.',
      'GET /api/instagram/connect-check returned 404, and that endpoint only exists on the new build.',
      'Deploy the current backend before doing anything else. Every fix the shot list assumes is missing from this build.');
    return finish();
  }
  if (connectCheck.status === 401 || connectCheck.status === 403) {
    fail('The API rejected the login token.', `HTTP ${connectCheck.status}`,
      'The token is expired or belongs to a different environment. Sign in again, or take a fresh access token out of the browser.');
    return finish();
  }
  if (!connectCheck.ok) {
    fail('connect-check did not answer.', connectCheck.error || `HTTP ${connectCheck.status}`,
      'Retry. If it keeps failing, the API is up but the Instagram router is not mounted.');
  } else {
    pass('The API is on a build that includes the Instagram hardening.');
    state.redirectUri = connectCheck.body.redirect_uri;
    if (connectCheck.body.ready === true) {
      pass('Instagram is configured on the server.',
        `App id from ${connectCheck.body.app_id_source}. Redirect URI: ${connectCheck.body.redirect_uri}`);
    } else {
      fail('Instagram is not configured correctly on the server.',
        (connectCheck.body.problems || []).join(' | ') || 'no detail given',
        'These are Railway environment variables. Read each problem literally: it names the variable and what to set it to.');
    }
    try {
      const rHost = new URL(connectCheck.body.redirect_uri).host;
      const aHost = new URL(API_BASE).host;
      if (rHost !== aHost) {
        warn('The redirect URI points at a different host from the API you are testing.',
          `Redirect URI host: ${rHost}. API host: ${aHost}.`,
          `This is fine if ${rHost} is an alias for the same service. It is not fine if the OAuth callback would land somewhere else. Confirm before Ellie connects.`);
      } else {
        pass('The redirect URI points at this API host.');
      }
    } catch { /* already reported above */ }
  }

  const hookVerify = await jsonFetch(`${API_BASE}/api/webhooks/instagram?hub.mode=subscribe&hub.verify_token=deliberately-wrong&hub.challenge=x`);
  if (hookVerify.status === 403) {
    pass('The Instagram webhook route is mounted and rejects a wrong verify token.');
  } else if (hookVerify.status === 200) {
    fail('The Instagram webhook accepted a deliberately wrong verify token.',
      'It answered 200 to hub.verify_token=deliberately-wrong.',
      'INSTAGRAM_VERIFY_TOKEN is unset or empty on the API. Set it, and set the identical string in the Meta dashboard.');
  } else {
    warn('Could not confirm the webhook route.', hookVerify.error || `HTTP ${hookVerify.status}`,
      'Expected a 403. Check the route is mounted at /api/webhooks/instagram.');
  }

  // -------------------------------------------------------- 2. OAuth scopes
  section('2. Does the consent screen ask for the right permissions');

  const connect = await jsonFetch(`${API_BASE}/api/instagram/connect`, { headers: auth });
  if (!connect.ok) {
    const why = ((connect.body && connect.body.problems) || [connect.body && connect.body.error])
      .filter(Boolean).join(' | ') || connect.error || `HTTP ${connect.status}`;
    fail('The API refused to build an Instagram consent URL.', why,
      'This is the same button Ellie taps to connect. It failing here means it will fail for her.');
  } else {
    let scopes = [];
    try {
      const u = new URL(connect.body.url);
      scopes = decodeURIComponent(u.searchParams.get('scope') || '')
        .split(',').map((s) => s.trim()).filter(Boolean);
    } catch {
      fail('The consent URL could not be parsed.', String((connect.body && connect.body.url) || '').slice(0, 120));
    }
    if (scopes.length) {
      const missing = REQUIRED_SCOPES.filter((s) => !scopes.includes(s));
      if (!missing.length) {
        pass('The consent screen asks for all three scopes.', scopes.join(', '));
      } else if (missing.includes('instagram_business_content_publish')) {
        fail('instagram_business_content_publish is NOT being requested.',
          `Requested: ${scopes.join(', ')}`,
          'This is the blocker in section 0.1 of docs/META_APP_REVIEW_INSTAGRAM.md. Add the scope to SCOPES in backend/src/routes/instagram.js, deploy, and only then have Ellie connect. A token minted from the current list cannot publish, and reconnecting afterwards is the only cure. Do not book the session until this passes.');
      } else {
        fail('A required scope is missing from the consent screen.',
          `Missing: ${missing.join(', ')}. Requested: ${scopes.join(', ')}`,
          'Add it to SCOPES in backend/src/routes/instagram.js, deploy, then reconnect.');
      }
    }
  }

  // -------------------------------------------------- 3. Connection status
  section('3. Is the account connected, live, and subscribed');

  const status = await jsonFetch(`${API_BASE}/api/instagram/status`, { headers: auth }, 30000);
  if (!status.ok) {
    fail('Could not read the Instagram connection status.',
      (status.body && status.body.error) || status.error || `HTTP ${status.status}`,
      'A 503 here means the beauticians read failed. Retry. If it persists, a column in that select has been renamed.');
    return finish();
  }

  if (!status.body.connected) {
    fail('No Instagram account is connected to this Florrie account.',
      'The status endpoint reports connected: false.',
      'Ellie needs to connect: Settings, the AI chip, the Instagram card, Connect. Do this AFTER the scope check in section 2 passes.');
    return finish();
  }
  pass('An Instagram account is connected.', `Account id: ${status.body.account_id}`);
  state.accountId = status.body.account_id;

  if (status.body.token_valid === true) {
    pass('The stored token is alive. Instagram answered a live call with it.');
  } else if (status.body.token_valid === false) {
    fail('The stored token is dead.', status.body.token_error || 'Instagram rejected it.',
      'The Settings card will be showing "Needs reconnecting". Tap Reconnect Instagram and go round the consent flow again. Inbound DMs would still arrive, because webhooks need no token, but every reply and every publish would fail.');
  } else {
    warn('Could not check whether the token works.', status.body.token_error || 'no answer from Instagram',
      'Not proof of a problem, but do not record on an unknown. Run this again in a minute.');
  }

  const handle = status.body.page_name;
  if (handle && !isPlaceholderHandle(handle)) {
    pass('A real Instagram handle is attached.', `@${String(handle).replace(/^@+/, '')}`);
  } else if (handle == null) {
    fail('No Instagram handle is known for this account.',
      'The Settings card will read "Connected" with no handle after it.',
      'A reviewer reads a missing handle as no account attached. Reconnect, which re-reads the username. If it stays empty, the token cannot read the profile, which usually means the app tester role has not been accepted.');
  } else {
    fail('The stored handle is the placeholder string, not a real handle.', `Stored: "${handle}"`,
      'Run section 5 of docs/SQL_2026-08-23_LAUNCH_SWEEP.sql to clear it, then load the Settings AI tab once, which refills it from Instagram.');
  }

  if (status.body.webhook_subscribed === true) {
    pass('The account is subscribed to the messages webhook. DMs will be delivered here.');
  } else if (status.body.webhook_subscribed === false) {
    fail('The account is NOT subscribed to the messages webhook.',
      'Instagram positively said this account is not subscribed to the messages field.',
      'No DM will ever arrive, and the card will still say Connected. The Settings Instagram card shows a warning with a Reconnect Instagram button. Tap that. Video A is impossible until this reads true.');
  } else {
    warn('Could not check the webhook subscription.',
      'The status endpoint returned null, which means the check itself did not answer.',
      'Run again. Do not record on a null: a card that says Connected while nothing is subscribed is exactly the failure this check exists for.');
  }

  // ------------------------------------------------------------- 4. The row
  section('4. The database row, and the columns the code writes best-effort');

  const rowRes = await jsonFetch(
    `${SUPABASE_URL}/rest/v1/beauticians?select=id,first_name,instagram_page_id,instagram_page_name,instagram_dm_mode,instagram_page_token&limit=1`,
    { headers: sbHeaders(token) },
  );
  const row = Array.isArray(rowRes.body) ? rowRes.body[0] : null;
  if (!row) {
    fail('Could not read the beautician row from Supabase.',
      (rowRes.body && rowRes.body.message) || rowRes.error || `HTTP ${rowRes.status}`,
      'Row-level security returns only your own row, so an empty result usually means this login is not linked to a beautician record. Sign in as the account that will be recorded.');
  } else {
    state.beauticianId = row.id;
    state.igToken = row.instagram_page_token || null;

    if (row.instagram_page_id && state.accountId && String(row.instagram_page_id) !== String(state.accountId)) {
      warn('The stored account id and the one the status endpoint reports disagree.',
        'Not necessarily broken, but it is the shape of the bug that stopped DMs routing in July.',
        'Make sure instagram_account_ids exists (checked below) so the webhook can match on any id rather than betting on one.');
    }

    const mode = row.instagram_dm_mode;
    if (mode === 'off') {
      pass('instagram_dm_mode is "off". Nothing will auto-reply to the reviewer test DM.');
    } else if (mode === 'ai' || mode === 'reply') {
      fail(`instagram_dm_mode is "${mode}". Florrie will answer the test DM before Ellie types anything.`,
        'The connect flow writes "ai" on every connect, so this is the default state after reconnecting.',
        'Settings, the AI chip, the card titled "Instagram DMs", tap "Store only". Careful: with "ai" stored, the card shows "Redirect to WhatsApp" as the ticked option, and tapping that ticked option sends an automatic "message me on WhatsApp instead" DM instead. Tap the option that is NOT highlighted.');
    } else if (mode === 'redirect') {
      fail('instagram_dm_mode is "redirect". The reviewer test DM will get an automatic WhatsApp redirect reply.',
        'On camera that reads as the app deflecting away from Instagram.',
        'Settings, the AI chip, the "Instagram DMs" card, tap "Store only".');
    } else {
      warn(`instagram_dm_mode is ${JSON.stringify(mode)}, which the webhook does not recognise.`,
        'Unrecognised values fall through to the legacy auto_reply_enabled flag, so the behaviour depends on a second setting.',
        'Set it explicitly: Settings, AI chip, "Instagram DMs", "Store only".');
    }
  }

  const columns = [
    ['beauticians', 'instagram_account_ids', 'FAIL',
      'Without it the webhook matches an inbound DM on instagram_page_id alone. If that id is not the one Meta puts on the delivery, the DM is dropped and never reaches the Inbox. This has already happened in production. It is the most likely cause of "the message just never turned up" on the day.'],
    ['beauticians', 'instagram_token_expires_at', 'WARN',
      'Only costs the early warning before the 60 day token dies. Harmless for the recording, since the token will be hours old.'],
    ['content_posts', 'failure_reason', 'WARN',
      'A failed publish is still marked failed and the reason still reaches the screen through the API response. Only the persisted reason on the row is lost.'],
    ['content_posts', 'media_kind', 'FAIL',
      'The Content compose form sends media_kind on every draft insert. Without the column the whole insert is rejected and "Save as Draft" does nothing, with no error on screen.'],
  ];
  for (const [table, column, severity, why] of columns) {
    const r = await columnExists(token, table, column);
    if (r.exists === true) {
      pass(`${table}.${column} exists.`);
    } else if (r.exists === false) {
      record(severity, `${table}.${column} is MISSING.`, why,
        'Run docs/SQL_2026-08-23_LAUNCH_SWEEP.sql in the Supabase SQL editor, then RESTART the Railway service (restart, not redeploy: PgBouncer caches the schema).');
    } else {
      warn(`Could not tell whether ${table}.${column} exists.`, r.msg,
        'Check this login has read access to that table.');
    }
  }

  // ----------------------------------------------------------- 5. The image
  section('5. The photo Instagram would have to fetch');

  const draftRes = await jsonFetch(
    `${SUPABASE_URL}/rest/v1/content_posts?select=id,caption,hashtags,image_url,status,created_at&status=eq.draft&image_url=not.is.null&order=created_at.desc&limit=1`,
    { headers: sbHeaders(token) },
  );
  const draft = Array.isArray(draftRes.body) ? draftRes.body[0] : null;

  if (!draft) {
    fail('There is no draft post with a photo on this account.',
      (draftRes.body && draftRes.body.message) ? `Query said: ${draftRes.body.message}` : 'The query returned nothing.',
      'Video B needs one. Content tab, "+ New Post", "Add a photo", "Feed post", write a caption, "Save as Draft". Then run this again. If Save as Draft appears to do nothing, that is the media_kind column above.');
  } else {
    pass('A draft post with a photo is waiting.',
      `Draft ${draft.id}, caption starts "${String(draft.caption || '').slice(0, 50)}"`);
    state.draft = draft;

    const problem = imageUrlProblem(draft.image_url);
    if (problem) {
      fail('The publish path would reject this photo before it ever contacted Instagram.', problem,
        'Re-upload the photo from the Content compose screen. If the link is a signed Supabase URL, the content-images bucket is private: see the next check.');
    } else {
      pass('The photo link is the right shape for Instagram to fetch.');

      // The check that actually matters. No credentials, no cookies, no
      // session: as close as we can get to standing where Meta's fetcher
      // stands.
      const img = await jsonFetch(draft.image_url, { redirect: 'follow' }, 25000);
      const ctype = (img.headers && img.headers.get && img.headers.get('content-type')) || '';
      if (img.status === 200 && /^image\//i.test(ctype)) {
        pass('An outside party can fetch the photo.', `HTTP 200, ${ctype}`);
      } else if (img.status === 200) {
        fail('The photo URL answers 200 but does not return an image.', `Content-Type: ${ctype || 'none'}`,
          'Meta will fetch this and get something that is not a picture, and the container will land in ERROR. Open the URL in a private browser window and see what comes back.');
      } else if ([400, 401, 403, 404].includes(img.status)) {
        fail('An outside party CANNOT fetch the photo. This is the single biggest publishing risk.',
          `HTTP ${img.status}. ${JSON.stringify(img.body || {}).slice(0, 200)}`,
          "Instagram fetches the image server side with none of our session, so a private bucket fails at the last step of the publish, several seconds after the tap. In the Supabase SQL editor: select id, public from storage.buckets where id = 'content-images'; and if public is false, update storage.buckets set public = true where id = 'content-images'; Then re-upload the photo and run this again.");
      } else {
        warn('Could not fetch the photo from outside.', img.error || `HTTP ${img.status}`,
          'A network blip here is not proof of a problem, but run it again before you record. This is the check worth being certain about.');
      }
    }
  }

  // -------------------------------------------------- 6. Container dry run
  section('6. Publishing dry run (creates a container, never publishes)');

  if (SKIP_CONTAINER) {
    skip('Skipped by --no-container.', 'Nothing about the publish path has been proven end to end.');
  } else if (!state.igToken) {
    skip('No Instagram token readable from the row.',
      'Either the account is not connected, or row-level security is hiding the column from this login. Sections 2 and 3 still cover the scope and the connection.');
  } else if (!state.draft || imageUrlProblem(state.draft.image_url)) {
    skip('No usable draft photo to test with.', 'Fix section 5 first, then run this again.');
  } else {
    const caption = [state.draft.caption, '', (state.draft.hashtags || []).join(' ')].filter(Boolean).join('\n');
    const create = await jsonFetch('https://graph.instagram.com/v21.0/me/media', {
      method: 'POST',
      headers: { Authorization: `Bearer ${state.igToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_url: state.draft.image_url, caption }),
    }, 30000);

    if (!create.ok || !create.body || !create.body.id) {
      const err = (create.body && create.body.error) || {};
      const msg = err.error_user_msg || err.message || create.error || `HTTP ${create.status}`;
      if (err.code === 200 || err.code === 10 || /permission|scope|oauth/i.test(String(msg))) {
        fail('Instagram refused to create a media container: a permissions problem.', msg,
          'Almost certainly the missing instagram_business_content_publish scope (section 2), or the app tester role not accepted on Ellie\'s Instagram account. Neither is fixable in the recording room.');
      } else if (err.code === 190) {
        fail('Instagram refused the token.', msg,
          'The token is dead or was revoked. Reconnect from Settings, AI, the Instagram card.');
      } else {
        fail('Instagram refused to create a media container.', msg,
          'Read the message literally: it is what Meta would say mid-take. A message about the media usually means Instagram could not fetch or could not accept the image. Try a smaller JPEG at a standard aspect ratio.');
      }
    } else {
      pass('Instagram accepted a media container. The publish scope and the token both work.',
        `Container ${create.body.id}`);

      // Poll exactly the way publishPost does, so a container that would
      // hang on camera hangs here instead.
      let finished = false;
      let last = null;
      for (let i = 0; i < 12; i++) {
        const s = await jsonFetch(
          `https://graph.instagram.com/v21.0/${create.body.id}?fields=status_code,status`,
          { headers: { Authorization: `Bearer ${state.igToken}` } }, 15000,
        );
        const code = s.body && s.body.status_code;
        last = (s.body && s.body.status) || code || s.error;
        if (code === 'FINISHED') { finished = true; break; }
        if (code === 'ERROR' || code === 'EXPIRED') break;
        if (i < 11) await sleep(2000);
      }

      if (finished) {
        pass('Instagram fetched the photo and finished processing it.',
          'The whole publish chain works apart from the final media_publish call, which is deliberately not made. This container was never published and expires on its own within 24 hours.');
      } else {
        fail('The container never reached FINISHED.', `Last status: ${last}`,
          'This is exactly what would happen on camera: the Approve & Post button spins and then reports a failure. Usually the image: check it is a JPEG under about 8 MB at a standard aspect ratio, and that section 5 passed. An ERROR status means Meta fetched the URL and did not like what came back.');
      }
    }
  }

  finish();
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

function finish() {
  const fails = results.filter((r) => r.status === 'FAIL');
  const warns = results.filter((r) => r.status === 'WARN');
  const skips = results.filter((r) => r.status === 'SKIP');
  const passes = results.filter((r) => r.status === 'PASS');

  console.log('\n' + '='.repeat(60));
  console.log(`\x1b[1mVerdict\x1b[0m   ${passes.length} passed, ${fails.length} failed, ${warns.length} warnings, ${skips.length} skipped`);
  console.log('='.repeat(60));

  if (fails.length) {
    console.log('\n\x1b[31mDo not record yet.\x1b[0m Fix these first:\n');
    fails.forEach((f, i) => {
      console.log(`  ${i + 1}. ${f.title}`);
      if (f.fix) console.log(`     ${f.fix}\n`);
    });
  } else if (warns.length) {
    console.log('\n\x1b[33mProbably fine, but read these before you set up.\x1b[0m\n');
    warns.forEach((w, i) => {
      console.log(`  ${i + 1}. ${w.title}`);
      if (w.fix) console.log(`     ${w.fix}\n`);
    });
  } else {
    console.log('\n\x1b[32mEverything this script can prove is proved. Go and record.\x1b[0m');
  }

  console.log('\nStill unproven by this script, and only provable by doing it:');
  console.log("  - that Ellie's Instagram account has accepted the app tester invite");
  console.log('  - that a real inbound DM routes to the right account and reaches the Inbox');
  console.log('  - that the device you record on is running a current frontend build');
  console.log('  - that the redirect URI registered in the Meta dashboard matches ours character for character');

  if (AS_JSON) console.log('\n' + JSON.stringify({ results }, null, 2));
  process.exit(fails.length ? 1 : 0);
}

main().catch((err) => {
  console.error('\n\x1b[31mThe rehearsal script itself threw.\x1b[0m');
  console.error((err && err.stack) || String(err));
  console.error('\nThat is a bug in the script, not a verdict on the recording. Read the stack, and fall back to checking by hand.');
  process.exit(3);
});
