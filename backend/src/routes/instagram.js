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
    problems.push('INSTAGRAM_APP_ID is not set and META_APP_ID is being used instead. The Meta App ID is not the Instagram app id — Instagram will reject it. Copy the id from Meta > Instagram > API setup with Instagram login.');
  }
  if (!IG_APP_SECRET) problems.push('INSTAGRAM_APP_SECRET is not set.');
  if (!process.env.INSTAGRAM_REDIRECT_URI) {
    problems.push(`INSTAGRAM_REDIRECT_URI is not set, so it defaults to ${REDIRECT_URI} — Instagram will reject that. Set it to https://<this-api-host>/api/instagram/callback and register the identical string in the Meta dashboard.`);
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
  const native = req.query.platform === 'native';
  const state = native ? `${req.beautician.id}|native` : String(req.beautician.id);

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

// GET /api/instagram/callback
// Instagram redirects here after the user approves.
router.get('/callback', async (req, res) => {
  const { code: rawCode, state: rawState, error: oauthError, error_description } = req.query;

  const [beauticianId, platform] = String(rawState || '').split('|');
  const isNative = platform === 'native';
  const redirectBase = `${FRONTEND_URL}/settings?section=ai`;

  // One place decides how this request ends, so no branch below can forget.
  const finish = (ok, detail) => (isNative
    ? res.status(200).type('html').send(nativeReturnPage(ok, detail))
    : res.redirect(`${redirectBase}&ig=${ok ? 'success' : 'error'}`));

  if (oauthError || !rawCode || !beauticianId) {
    logger.warn({ oauthError, error_description, hasCode: !!rawCode }, 'Instagram OAuth callback rejected');
    return finish(false, error_description || oauthError || null);
  }

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

    // Step 3 — read the account id + username. In the Instagram Login flow the
    // /me "user_id" is the same id Meta sends as webhook entry.id, so we store it
    // for inbound DM routing.
    let accountId = shortUserId || null;
    let username  = null;
    try {
      const meRes = await fetch(
        `https://graph.instagram.com/v21.0/me` +
        `?fields=user_id,username,name` +
        `&access_token=${encodeURIComponent(userToken)}`
      );
      const meData = await meRes.json();
      accountId = meData.user_id || meData.id || accountId;
      username  = meData.username || meData.name || null;
    } catch (err) {
      logger.warn({ err }, 'Instagram: /me lookup failed, using token user_id');
    }

    if (!accountId) {
      logger.error({ beauticianId }, 'Instagram: could not determine account id');
      return finish(false, 'we could not read your account');
    }

    // Step 4 — store on the beautician row.
    const { error: updateErr } = await supabase
      .from('beauticians')
      .update({
        instagram_page_id:    String(accountId),
        instagram_page_token: userToken,
        instagram_page_name:  username || 'Instagram',
        instagram_dm_mode:    'ai', // connecting = Florrie answers DMs (changeable later)
      })
      .eq('id', beauticianId);

    if (updateErr) {
      logger.error({ err: updateErr }, 'Instagram: failed to save credentials');
      return finish(false, 'we could not save the connection');
    }

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
    finish(false);
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
    if (data.instagram_page_token) {
      try {
        const r = await fetch('https://graph.instagram.com/v21.0/me?fields=id', {
          headers: { Authorization: `Bearer ${data.instagram_page_token}` },
        });
        const body = await r.json().catch(() => ({}));
        tokenValid = r.ok;
        if (!r.ok) tokenError = body?.error?.message || `HTTP ${r.status}`;
      } catch (err) {
        tokenError = 'Could not reach Instagram';
      }
    } else {
      tokenValid = false;
      tokenError = 'No access token stored';
    }

    res.json({
      connected: true,
      page_name: data.instagram_page_name || 'Instagram',
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

    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'Instagram disconnect error');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

export default router;
