/**
 * Instagram OAuth — Connect an Instagram professional account so Florrie can
 * read and reply to the beautician's DMs.
 *
 * Uses the **Instagram Business Login** flow (a.k.a. "Instagram Login"), NOT the
 * older Facebook Login flow. The beautician does NOT need a Facebook Page — they
 * log in with the Instagram account directly. This matches how the Meta app's
 * Instagram product is configured (Instagram app id + Instagram app secret,
 * graph.instagram.com, instagram_business_* scopes).
 *
 * Flow:
 *   1. GET /api/instagram/connect  → returns the instagram.com OAuth URL
 *   2. GET /api/instagram/callback → exchanges code → long-lived token, stores it
 *   3. GET /api/instagram/status   → returns connection status
 *   4. POST /api/instagram/disconnect → clears stored credentials
 *
 * Required env vars:
 *   INSTAGRAM_APP_ID       — the Instagram app's client id (e.g. 1427547881961219)
 *   INSTAGRAM_APP_SECRET   — the Instagram app's client secret
 *   INSTAGRAM_REDIRECT_URI — must EXACTLY match a redirect URI registered under the
 *                            app's "Instagram > API setup with Instagram login >
 *                            Business login settings" (e.g.
 *                            https://api.florrie.ai/api/instagram/callback)
 *   FRONTEND_URL           — e.g. https://florrie.ai (for redirect after auth)
 *
 * (Falls back to META_APP_ID / META_APP_SECRET only if the INSTAGRAM_* vars are
 * unset, so an old single-app setup still half-works, but the Instagram Login
 * flow really wants the Instagram-scoped credentials.)
 *
 * Scopes requested (Instagram Login scope names):
 *   instagram_business_basic            — read profile + media
 *   instagram_business_manage_messages  — read + reply to DMs
 *
 * After OAuth we store on the beautician row (column names kept stable so the
 * rest of the code — ai-front-desk send path, webhook lookup — works unchanged):
 *   instagram_page_id    — the Instagram account id (matches webhook entry.id)
 *   instagram_page_token — a long-lived Instagram user access token (60 days)
 *   instagram_page_name  — the @username
 */

import { Router } from 'express';
import { supabase } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import {
  signOAuthState,
  inspectOAuthState,
  peekOAuthStateClaims,
  oauthStateSecretProblem,
} from '../lib/oauth-state.js';
import logger from '../lib/logger.js';

const router = Router();

const IG_APP_ID     = process.env.INSTAGRAM_APP_ID || process.env.META_APP_ID;
const IG_APP_SECRET = process.env.INSTAGRAM_APP_SECRET || process.env.META_APP_SECRET;
const REDIRECT_URI  = process.env.INSTAGRAM_REDIRECT_URI || 'http://localhost:3001/api/instagram/callback';
const FRONTEND_URL  = process.env.FRONTEND_URL;

/**
 * The two ways this is misconfigured while LOOKING configured.
 *
 * `igConfigured()` only asks whether an id and a secret exist, so both of
 * these pass it and then fail at Instagram, on Instagram's own error page,
 * with nothing in our logs at all:
 *
 *  - META_APP_ID picked up as the fallback. The Meta App ID at the top of the
 *    dashboard is NOT the Instagram app id, and instagram.com/oauth/authorize
 *    rejects it. The fallback was meant as a convenience and instead turns a
 *    missing variable into a wrong one.
 *  - REDIRECT_URI still on the localhost default. Instagram compares it
 *    character for character against the registered list, so this fails before
 *    the login form is even drawn — which is exactly "it won't connect and it
 *    won't log her in".
 *
 * Both are invisible from the outside. So they are reported: at boot, and on
 * demand from /connect-check, without ever printing the secret.
 */
export function igConfigProblems() {
  const problems = [];
  if (!IG_APP_ID) problems.push('INSTAGRAM_APP_ID is not set.');
  else if (!process.env.INSTAGRAM_APP_ID && process.env.META_APP_ID) {
    problems.push('INSTAGRAM_APP_ID is not set and META_APP_ID is being used instead. The Meta App ID is not the Instagram app id. Instagram will reject it. Copy the id from Meta > Instagram > API setup with Instagram login.');
  }
  if (!IG_APP_SECRET) problems.push('INSTAGRAM_APP_SECRET is not set.');
  if (!process.env.INSTAGRAM_REDIRECT_URI) {
    problems.push(`INSTAGRAM_REDIRECT_URI is not set, so it defaults to ${REDIRECT_URI}, which Instagram will reject. Set it to https://<this-api-host>/api/instagram/callback and register the identical string in the Meta dashboard.`);
  } else if (/^http:\/\/(localhost|127\.)/.test(REDIRECT_URI)) {
    problems.push(`INSTAGRAM_REDIRECT_URI points at ${REDIRECT_URI}, which only works on a developer machine.`);
  }
  return problems;
}

// Said once, at boot, so it is in the deploy log rather than waiting to be
// discovered by a beautician tapping a button that does nothing.
for (const p of igConfigProblems()) logger.warn({ integration: 'instagram' }, p);

// Instagram Login scopes. Comma-separated per Meta's docs.
const SCOPES = [
  'instagram_business_basic',
  'instagram_business_manage_messages',
  // Publishing was built, wired to a scheduler, and never requested here, so
  // every token this flow has ever minted could read and reply to DMs and
  // could not post. The Content page's Publish button was calling Meta with a
  // token that had no permission to do it.
  //
  // It has to be in the list BEFORE anyone connects, because the permissions
  // on a token are fixed at authorisation time. Adding it later means every
  // connected account has to reconnect, and it means the Meta App Review
  // screencast for instagram_business_content_publish cannot be recorded at
  // all, since there is nothing to record.
  'instagram_business_content_publish',
].join(',');

function igConfigured() {
  return !!(IG_APP_ID && IG_APP_SECRET);
}

// GET /api/instagram/connect
// Returns the Instagram OAuth URL the frontend should open.
/**
 * GET /api/instagram/connect-check
 *
 * What is actually wrong, in words, without leaking a secret. Ellie tried this
 * on her phone and in a browser and it failed both times, and from the outside
 * every one of the failure modes above looks identical: a button, then an
 * Instagram error page. Guessing at it across three dashboards is not a
 * debugging strategy.
 *
 * Auth required, and the response carries no id and no secret — only whether
 * each is present, where the id came from, and the redirect uri, which is
 * public by definition because it travels in the OAuth url.
 */
router.get('/connect-check', requireAuth, (req, res) => {
  const problems = igConfigProblems();
  res.json({
    ready: problems.length === 0,
    problems,
    app_id_source: process.env.INSTAGRAM_APP_ID ? 'INSTAGRAM_APP_ID'
      : process.env.META_APP_ID ? 'META_APP_ID (wrong one)' : 'not set',
    app_secret_set: !!IG_APP_SECRET,
    redirect_uri: REDIRECT_URI,
    register_this_exact_uri_in_meta: REDIRECT_URI,
    scopes: SCOPES.split(','),
  });
});

router.get('/connect', requireAuth, (req, res) => {
  // Report the actual problem rather than "contact support". She IS support.
  const problems = igConfigProblems();
  if (!igConfigured() || problems.length) {
    return res.status(503).json({
      error: problems[0] || 'Instagram is not set up on the server yet.',
      problems,
    });
  }

  // The app has to tell us where it is running, because the two cases need
  // different endings. Instagram will not render its login inside an embedded
  // WKWebView, so the iOS app hands the url to Safari; that means the callback
  // lands in a browser tab with no Florrie session, and redirecting it to
  // /settings would drop her on a login screen. She gets a plain "done, go
  // back to the app" page instead. On the web the redirect is still right.
  //
  // Carried in `state` rather than a query parameter because state is the only
  // thing Instagram gives back to us, and it is already round-tripping.
  //
  // It now rides INSIDE the signed payload rather than as a `|native` suffix.
  // The suffix was appended to an id the client could choose, and the callback
  // trusted the whole thing, which is how someone else's Instagram account
  // could end up wired to her Florrie. Same information, no longer forgeable.
  const native = req.query.platform === 'native';

  // Do not start a flow that cannot be finished. Better a plain 503 naming the
  // variable than a login that dead ends on the way back.
  const secretProblem = oauthStateSecretProblem();
  if (secretProblem) {
    logger.error({ integration: 'instagram' }, secretProblem);
    return res.status(503).json({ error: secretProblem, problems: [secretProblem] });
  }

  const state = signOAuthState({
    beauticianId: String(req.beautician.id),
    ...(native ? { platform: 'native' } : {}),
  });

  const url =
    `https://www.instagram.com/oauth/authorize` +
    `?client_id=${encodeURIComponent(IG_APP_ID)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent(SCOPES)}` +
    `&state=${encodeURIComponent(state)}`;

  res.json({ url });
});

/**
 * The page a phone lands on after finishing in Safari.
 *
 * Self contained on purpose: this tab has no Florrie session and no app shell,
 * so it must not link anywhere that needs a login. It says what happened and
 * tells her to go back to the app, which re-checks the connection when it comes
 * back to the foreground.
 */
function nativeReturnPage(ok, detail) {
  const title = ok ? 'Instagram connected' : 'That did not connect';
  // `detail` originates in req.query and this endpoint is unauthenticated by
  // design, so anyone can craft a callback url that reaches this page. Without
  // escaping, error_description is reflected script on api.florrie.ai.
  const safeDetail = String(detail || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
    .slice(0, 200);
  const body = ok
    ? 'You can close this tab and go back to Florrie. Your Instagram card will turn green.'
    : `Close this tab, go back to Florrie and tap Reconnect Instagram to try again.${safeDetail ? ` (${safeDetail})` : ''}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title}</title></head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#FBF6F1;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#241B17">
<div style="max-width:22rem;padding:2rem;text-align:center">
<div style="font-size:2.5rem;line-height:1;margin-bottom:1rem">${ok ? '\u2713' : '\u26A0'}</div>
<h1 style="font-size:1.25rem;margin:0 0 .75rem;color:${ok ? '#92405E' : '#241B17'}">${title}</h1>
<p style="font-size:.95rem;line-height:1.6;margin:0;color:#6b5a55">${body}</p>
</div></body></html>`;
}

/** Bare handle, no leading @, so stored handles and looked-up ones agree. */
export function normaliseHandle(raw) {
  const h = String(raw || '').trim().replace(/^@+/, '');
  return h || null;
}

/**
 * A stored instagram_page_name that is not actually a handle.
 *
 * "Instagram" is the literal string the old connect code wrote whenever the
 * username came back empty, so it is on real rows today and has to be treated
 * as "we never learned the handle", not as her account name.
 */
export function isPlaceholderPageName(name) {
  const n = String(name || '').trim().toLowerCase();
  return !n || n === 'instagram' || n === 'instagram user';
}

/**
 * Ask graph.instagram.com who this token belongs to.
 *
 * Returns { accountId, username, allIds }.
 *
 * Two things are deliberate here.
 *
 * 1. `allIds` collects every distinct id the flow saw: the user_id the token
 *    exchange returned, and both `user_id` and `id` from /me. Instagram
 *    returns these as separate fields and they are NOT always the same value,
 *    which is exactly how a stored id and a webhook entry.id came to disagree
 *    in production.
 * 2. The username is chased across more than one field list. Asking for
 *    `username` together with other fields can fail as a whole on some
 *    accounts, and the old code read one response and gave up, which is how
 *    the handle ended up missing and "Instagram" ended up on the card. `name`
 *    is a display name, never a handle, so it is only ever a last resort and
 *    is normalised the same way.
 */
export async function readInstagramAccount(userToken, tokenUserId) {
  const ids = [];
  const addId = (v) => {
    const s = v == null ? '' : String(v).trim();
    if (s && !ids.includes(s)) ids.push(s);
  };
  addId(tokenUserId);

  let username = null;
  let primary = null;

  const attempts = ['user_id,username,name', 'user_id,username', 'username', 'user_id', 'id'];
  for (const fields of attempts) {
    try {
      const meRes = await fetch(
        `https://graph.instagram.com/v21.0/me` +
        `?fields=${encodeURIComponent(fields)}` +
        `&access_token=${encodeURIComponent(userToken)}`
      );
      const meData = await meRes.json().catch(() => ({}));
      if (!meRes.ok) {
        logger.warn({ fields, err: meData?.error || meRes.status }, 'Instagram: /me lookup rejected, trying fewer fields');
        continue;
      }
      addId(meData.user_id);
      addId(meData.id);
      if (!primary) primary = meData.user_id || meData.id || null;
      // ONLY `username`. `name` is a display name ("Ellindigo Beauty"), and
      // the Settings card prints this with an @ in front of it, so borrowing
      // the display name produces "@Ellindigo Beauty", which is not an account
      // anybody can look up. No handle is honest; a fake handle is not.
      if (!username) username = normaliseHandle(meData.username);
      if (primary && username) break;
    } catch (err) {
      logger.warn({ err, fields }, 'Instagram: /me lookup threw, trying fewer fields');
    }
  }

  // The id we route and publish on. Prefer what /me called user_id, fall back
  // to whatever else we have, but every candidate is kept in allIds either way.
  const accountId = primary || ids[0] || null;
  if (accountId) addId(accountId);

  return { accountId, username, allIds: ids };
}

/**
 * One column, written on its own, allowed to fail.
 *
 * Every caller below is writing something that improves the connection but is
 * not the connection. PostgREST rejects an entire write if a single column in
 * it is unknown, so folding any of these into the main patch would let a
 * migration nobody has run yet turn a successful login into a row with no
 * token at all. Separate write, logged, never fatal.
 */
async function bestEffort(beauticianId, patch, note) {
  const { error } = await supabase
    .from('beauticians')
    .update(patch)
    .eq('id', beauticianId);
  if (error) {
    logger.warn({ err: error, beauticianId, patch }, note);
    return false;
  }
  return true;
}

/**
 * Best-effort write of every candidate id.
 *
 * Without the column this is a no-op and routing falls back to
 * instagram_page_id, which is what happens today. With it, an entry.id that
 * disagrees with our primary id routes anyway.
 */
export async function saveAccountIdCandidates(beauticianId, allIds) {
  const ids = (allIds || []).map(String).filter(Boolean);
  if (!beauticianId || !ids.length) return false;
  const saved = await bestEffort(beauticianId, { instagram_account_ids: ids },
    'Instagram: could not save instagram_account_ids (is the column there?). Routing falls back to instagram_page_id alone.');
  if (saved) logger.info({ beauticianId, ids }, 'Instagram: saved every account id this login reported');
  return saved;
}

/**
 * When this token dies, written down at the only moment we are told.
 *
 * lib/health.js already reads beauticians.instagram_token_expires_at and warns
 * on anything close to expiry, and already falls back quietly when the column
 * is missing. Nothing has ever written it, so that warning has never once
 * fired. The long-lived exchange returns expires_in (about 60 days) and this
 * is the only place it is ever visible, so it is recorded here. The daily
 * refresh keeps the token alive; this is what notices when the refresh has
 * stopped working, which is the failure that went five weeks unseen.
 */
export async function saveTokenExpiry(beauticianId, expiresInSeconds) {
  const secs = Number(expiresInSeconds);
  if (!beauticianId || !Number.isFinite(secs) || secs <= 0) return false;
  const at = new Date(Date.now() + secs * 1000).toISOString();
  return bestEffort(beauticianId, { instagram_token_expires_at: at },
    'Instagram: could not save instagram_token_expires_at (is the column there?). The health check cannot warn before this token expires.');
}

// GET /api/instagram/callback
// Instagram redirects here after the user approves.
router.get('/callback', async (req, res) => {
  const { code: rawCode, state: rawState, error: oauthError, error_description } = req.query;

  // How to END this request is a presentation question, not a security one, and
  // it has to be answered even when the state is rubbish: a phone that gets a
  // redirect to /settings lands on a login form in a stray Safari tab with no
  // session, which looks like nothing happened at all. So the platform marker
  // is read unverified, and ONLY to pick which page to draw. The legacy
  // `|native` suffix is still recognised here for the same reason: someone who
  // tapped Connect just before this deployed should still get the apology page
  // rather than a dead end. It never decides whose row gets written.
  const isNative = peekOAuthStateClaims(rawState).platform === 'native'
    || /\|native$/.test(String(rawState || ''));
  const redirectBase = `${FRONTEND_URL}/settings?section=ai`;

  // One place decides how this request ends, so no branch below can forget.
  const finish = (ok, detail) => (isNative
    ? res.status(200).type('html').send(nativeReturnPage(ok, detail))
    : res.redirect(
      `${redirectBase}&ig=${ok ? 'success' : 'error'}`
      // WHY THE REASON TRAVELS, added 31 August 2026. The owner spent a week
      // completing this flow in Safari and coming back to a card that still
      // said "Not connected", and there was no way for her, or for me, to tell
      // which of five failures it was: the reason was written to a server log
      // nobody reads and the browser was handed the single word "error". The
      // native branch has always shown the detail on its own page. The web
      // branch threw it away. Same failure, half the truth, and the half that
      // reached the person who could act on it was the useless half.
      + (!ok && detail ? `&ig_detail=${encodeURIComponent(String(detail).slice(0, 120))}` : '')
    ));

  if (oauthError || !rawCode) {
    logger.warn({ oauthError, error_description, hasCode: !!rawCode }, 'Instagram OAuth callback rejected');
    return finish(false, error_description || oauthError || null);
  }

  // The id comes out of a signature we made, never off the wire. `state` was
  // the beautician id in the clear, so anyone could complete this flow with
  // their own Instagram account against a victim's public id: her DMs would
  // stop reaching her, and Florrie would start answering the attacker's DMs
  // with her diary and her prices.
  const checked = inspectOAuthState(rawState);
  if (!checked.ok || !checked.payload.beauticianId) {
    logger.warn(
      {
        integration: 'instagram',
        reason: checked.reason || 'no_beautician_id',
        isNative,
        stateLength: typeof rawState === 'string' ? rawState.length : 0,
      },
      'Instagram OAuth callback refused: the state did not verify',
    );
    // NAME THE ACTUAL REASON. Until 31 August 2026 every state failure said
    // "that link expired", including BAD_SIGNATURE, which is what was really
    // happening: the app mints the state on one host and the callback verifies
    // it on another, and the two do not share a signing key, so the signature
    // never matched and the owner was told her link had expired seconds after
    // it was made. A week was spent looking for a slow login.
    return finish(false, checked.reason === 'EXPIRED'
      ? 'that link expired, please try again from Florrie'
      : `the sign in could not be verified (${checked.reason || 'unknown'}), please tell Levi`);
  }
  const beauticianId = checked.payload.beauticianId;

  // Instagram appends a trailing "#_" fragment to the code on web redirects; the
  // query parser usually drops it, but strip defensively.
  const code = String(rawCode).replace(/#_$/, '');

  try {
    // Step 1 — exchange the code for a short-lived (1h) Instagram user token.
    const tokenRes = await fetch('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     IG_APP_ID,
        client_secret: IG_APP_SECRET,
        grant_type:    'authorization_code',
        redirect_uri:  REDIRECT_URI,
        code,
      }),
    });
    const tokenData = await tokenRes.json();

    // Response shape is either { access_token, user_id, permissions } or, on some
    // versions, { data: [{ access_token, user_id, permissions }] }.
    const shortToken = tokenData.access_token || tokenData?.data?.[0]?.access_token;
    const shortUserId = tokenData.user_id || tokenData?.data?.[0]?.user_id;

    if (!shortToken) {
      logger.error({ tokenData }, 'Instagram: code exchange failed');
      return finish(false, 'the login could not be completed');
    }

    // Step 2 — exchange for a long-lived (60-day) Instagram user token.
    const longRes = await fetch(
      `https://graph.instagram.com/access_token` +
      `?grant_type=ig_exchange_token` +
      `&client_secret=${encodeURIComponent(IG_APP_SECRET)}` +
      `&access_token=${encodeURIComponent(shortToken)}`
    );
    const longData = await longRes.json();
    const userToken = longData.access_token || shortToken;

    // Step 3: read every id this login can tell us about, and the @handle.
    //
    // The comment that used to sit here said the /me "user_id" is the same id
    // Meta sends as webhook entry.id. That was a guess, and it was wrong in
    // production: a stored instagram_page_id did not match entry.id and DMs
    // did not route until somebody edited the row by hand.
    //
    // Instagram's own docs describe entry.id only as "the object's ID" and
    // describe the account elsewhere as an "Instagram-scoped ID", while
    // /me can hand back BOTH an `id` and a `user_id` that are different
    // numbers, and the token exchange hands back a third. Picking one and
    // hoping is the bug. So: learn all of them, keep all of them, and let the
    // webhook match on any. Routing then cannot be wrong unless Meta sends an
    // id we were never told about at all, which is a case we log rather than
    // guess at.
    const { accountId, username, allIds } = await readInstagramAccount(userToken, shortUserId);

    if (!accountId) {
      logger.error({ beauticianId }, 'Instagram: could not determine account id');
      return finish(false, 'we could not read your account');
    }

    // Step 4 — store on the beautician row.
    //
    // instagram_page_name is only written when we actually learned a handle.
    // It used to be written as the literal string "Instagram" whenever the
    // lookup came back empty, and the Settings card then read "Connected,
    // Instagram", which to a Meta reviewer looks like no account is attached.
    // A reconnect that fails to read the handle must also not wipe a good one
    // that an earlier connect captured.
    const patch = {
      instagram_page_id:    String(accountId),
      instagram_page_token: userToken,
    };
    if (username) patch.instagram_page_name = username;

    // Connecting used to set instagram_dm_mode to 'ai', which meant that the
    // act of plugging Instagram in also switched on Florrie answering strangers
    // unsupervised. At a new salon that is the worst possible moment for it:
    // isKnownClient is "has ever had an appointment", so at zero clients nobody
    // is known, the hold-for-approval branch cannot fire, and the first person
    // who ever messages her gets an unreviewed reply. It also ruins a Meta
    // review screencast, where the reviewer's test DM is answered before the
    // owner has typed a word.
    //
    // So connecting no longer decides. A salon that has already chosen a mode
    // keeps it across a reconnect, and one that has never chosen starts silent:
    // the DM lands in her inbox and nothing is sent back until she picks.
    const { data: existingMode, error: modeErr } = await supabase
      .from('beauticians')
      .select('instagram_dm_mode')
      .eq('id', beauticianId)
      .maybeSingle();
    if (modeErr) {
      logger.warn({ err: modeErr, beauticianId }, 'Instagram: could not read the existing DM mode, leaving it alone');
    } else if (!existingMode?.instagram_dm_mode) {
      patch.instagram_dm_mode = 'off';
    }

    const { error: updateErr } = await supabase
      .from('beauticians')
      .update(patch)
      .eq('id', beauticianId);

    if (updateErr) {
      logger.error({ err: updateErr }, 'Instagram: failed to save credentials');
      return finish(false, 'we could not save the connection');
    }

    // Every other id this login mentioned, so the webhook can match on any of
    // them. Deliberately a SECOND write: instagram_account_ids arrives in a
    // migration that is applied by hand, and PostgREST rejects the whole
    // update if one column is unknown. Folding it into the patch above would
    // turn a missing migration into a connect flow that saves nothing at all,
    // which is a far worse failure than routing on one id.
    await saveAccountIdCandidates(beauticianId, allIds);
    await saveTokenExpiry(beauticianId, longData.expires_in);

    // Step 5 — subscribe this account to the app's message webhooks so inbound
    // DMs reach POST /api/webhooks/instagram. Non-fatal: connection still counts
    // as successful if this fails (it can be retried).
    try {
      const subRes = await fetch(
        `https://graph.instagram.com/v21.0/me/subscribed_apps` +
        `?subscribed_fields=messages` +
        `&access_token=${encodeURIComponent(userToken)}`,
        { method: 'POST' }
      );
      const subData = await subRes.json().catch(() => ({}));
      if (!subRes.ok || subData.success === false) {
        logger.warn({ beauticianId, subData }, 'Instagram: webhook subscribe returned an error');
      } else {
        logger.info({ beauticianId, accountId }, 'Instagram: account subscribed to message webhooks');
      }
    } catch (err) {
      logger.warn({ err, beauticianId }, 'Instagram: webhook subscribe failed (non-fatal)');
    }

    logger.info({ beauticianId, accountId, username }, 'Instagram account connected (Instagram Login flow)');
    finish(true);

  } catch (err) {
    logger.error({ err }, 'Instagram OAuth callback error');
    finish(false, err?.message ? `something went wrong: ${err.message}` : 'something went wrong');
  }
});

// GET /api/instagram/status
// Returns connection status for the current beautician.
router.get('/status', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('beauticians')
      .select('instagram_page_id, instagram_page_name, instagram_page_token')
      .eq('id', req.beautician.id)
      .single();

    // Checked, because the alternative is the worst answer this endpoint can
    // give. PostgREST rejects the whole select if one column name is unknown,
    // and one of these columns has already been renamed once (migration 067).
    // An unchecked read would leave data null and report "not connected" for an
    // account that is connected, sending her round a reconnect she does not need.
    if (error) {
      logger.error({ err: error, beauticianId: req.beautician.id }, 'Instagram status lookup failed');
      return res.status(503).json({ error: 'Could not check Instagram just now' });
    }

    if (!data?.instagram_page_id) return res.json({ connected: false });

    // Storing an id is NOT the same as being connected. Ellie's token expired
    // on 21 June and this endpoint kept reporting "connected" for five weeks
    // while every outbound call (replies, publishing, profile names) failed.
    // Inbound DMs keep arriving because webhooks need no token, so nothing
    // looked wrong. Actually ask Instagram whether the token still works.
    let tokenValid = null;   // null = could not check
    let tokenError = null;
    let liveHandle = null;
    if (data.instagram_page_token) {
      try {
        // Ask for the handle in the same breath as the liveness check. It is
        // the same request either way, and it is the one thing a Meta reviewer
        // reads off this card to decide whether a real account is attached.
        const r = await fetch('https://graph.instagram.com/v21.0/me?fields=user_id,username', {
          headers: { Authorization: `Bearer ${data.instagram_page_token}` },
        });
        const body = await r.json().catch(() => ({}));
        tokenValid = r.ok;
        if (!r.ok) tokenError = body?.error?.message || `HTTP ${r.status}`;
        else liveHandle = normaliseHandle(body?.username);
      } catch (err) {
        tokenError = 'Could not reach Instagram';
      }
    } else {
      tokenValid = false;
      tokenError = 'No access token stored';
    }

    // Self-heal the handle. Rows connected before this existed carry the
    // literal string "Instagram", which reads as an unconnected account. One
    // load of the Settings card now repairs it permanently, with no reconnect
    // and no hand-edited row.
    let pageName = isPlaceholderPageName(data.instagram_page_name) ? null : data.instagram_page_name;
    if (liveHandle && liveHandle !== pageName) {
      pageName = liveHandle;
      const { error: nameErr } = await supabase
        .from('beauticians')
        .update({ instagram_page_name: liveHandle })
        .eq('id', req.beautician.id);
      if (nameErr) logger.warn({ err: nameErr }, 'Instagram: could not save the repaired handle');
    }

    // Is this account actually subscribed to message webhooks?
    //
    // Connecting does two separate things: it stores a token, and it POSTs
    // /me/subscribed_apps so Meta starts delivering DMs here. The second one
    // is non-fatal at connect time, by design, because a connection is still
    // worth having without it. The cost of that choice is a card that says
    // Connected while no DM will ever arrive, which is indistinguishable from
    // a working setup right up until somebody sends a message and waits.
    // Asked here so it can be checked before it matters.
    let webhookSubscribed = null;   // null = could not check
    if (tokenValid) {
      try {
        const s = await fetch('https://graph.instagram.com/v21.0/me/subscribed_apps', {
          headers: { Authorization: `Bearer ${data.instagram_page_token}` },
        });
        const sBody = await s.json().catch(() => ({}));
        if (s.ok) {
          const apps = Array.isArray(sBody?.data) ? sBody.data : [];
          webhookSubscribed = apps.some(a =>
            (a?.subscribed_fields || []).some(f => String(f?.name || f) === 'messages'));
        }
      } catch (err) {
        // Leave it null. "We could not check" is not "it is broken".
      }
    }

    res.json({
      connected: true,
      // No more inventing "Instagram" as a name. Null means we genuinely do
      // not know the handle, and the card can say so instead of lying quietly.
      page_name: pageName,
      // true / false / null. Only ever false when Instagram positively said
      // this account is not subscribed to the messages field.
      webhook_subscribed: webhookSubscribed,
      account_id: data.instagram_page_id,
      token_valid: tokenValid,
      // The app should surface a reconnect prompt on this, not on `connected`.
      needs_reconnect: tokenValid === false,
      token_error: tokenError,
    });
  } catch (err) {
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// POST /api/instagram/disconnect
// Clears the stored Instagram credentials.
router.post('/disconnect', requireAuth, async (req, res) => {
  try {
    await supabase
      .from('beauticians')
      .update({
        instagram_page_id:    null,
        instagram_page_token: null,
        instagram_page_name:  null,
      })
      .eq('id', req.beautician.id);

    // Separate and fail-soft for the same reason as the connect path: a column
    // that may not be there yet must not take the disconnect down with it.
    // Leaving stale ids behind would let a later webhook route a DM to an
    // account she has explicitly unhooked.
    const { error: idsErr } = await supabase
      .from('beauticians')
      .update({ instagram_account_ids: null })
      .eq('id', req.beautician.id);
    if (idsErr) logger.warn({ err: idsErr }, 'Instagram disconnect: could not clear instagram_account_ids');

    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'Instagram disconnect error');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

export default router;
