/**
 * Instagram OAuth — Connect an Instagram Business account for direct posting.
 *
 * Flow:
 *   1. GET /api/instagram/connect  → redirects user to Meta Facebook Login
 *   2. GET /api/instagram/callback → exchanges code, finds IG business account, stores tokens
 *   3. GET /api/instagram/status   → returns connection status
 *   4. POST /api/instagram/disconnect → clears stored credentials
 *
 * Required env vars:
 *   META_APP_ID           — Facebook App ID
 *   META_APP_SECRET       — Facebook App Secret
 *   INSTAGRAM_REDIRECT_URI — e.g. https://api.florrie.ai/api/instagram/callback
 *   FRONTEND_URL          — e.g. https://florrie.ai (for redirect after auth)
 *
 * Scopes requested:
 *   instagram_basic             — view profile + media
 *   instagram_content_publish   — create + publish posts
 *   pages_read_engagement       — read page engagement data
 *   pages_show_list             — list pages so we can find the right one
 *
 * After OAuth, we store on the beautician row:
 *   instagram_page_id    — the Instagram Business Account ID (used by content-autopilot.js)
 *   instagram_page_token — a long-lived Page access token (60-day, auto-refreshed)
 */

import { Router } from 'express';
import { supabase } from '../index.js';
import { requireAuth } from '../middleware/auth.js';
import logger from '../lib/logger.js';

const router = Router();

const META_APP_ID       = process.env.META_APP_ID;
const META_APP_SECRET   = process.env.META_APP_SECRET;
const REDIRECT_URI      = process.env.INSTAGRAM_REDIRECT_URI || 'http://localhost:3001/api/instagram/callback';
const FRONTEND_URL      = process.env.FRONTEND_URL;

const SCOPES = [
  'instagram_basic',
  'instagram_content_publish',
  'pages_read_engagement',
  'pages_show_list',
].join(',');

function metaConfigured() {
  return !!(META_APP_ID && META_APP_SECRET);
}

// ───────────────────────────────────────────────────────
// GET /api/instagram/connect
// Returns the Facebook OAuth URL the frontend should open.
// ───────────────────────────────────────────────────────
router.get('/connect', requireAuth, (req, res) => {
  if (!metaConfigured()) {
    return res.status(503).json({ error: 'Instagram integration not configured — contact support' });
  }

  const url =
    `https://www.facebook.com/v21.0/dialog/oauth` +
    `?client_id=${META_APP_ID}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&scope=${encodeURIComponent(SCOPES)}` +
    `&response_type=code` +
    `&state=${req.beautician.id}`;

  res.json({ url });
});

// ───────────────────────────────────────────────────────
// GET /api/instagram/callback
// Meta redirects here after the user approves.
// ───────────────────────────────────────────────────────
router.get('/callback', async (req, res) => {
  const { code, state: beauticianId, error: oauthError } = req.query;

  const redirectBase = `${FRONTEND_URL}/settings?section=ai`;

  if (oauthError || !code || !beauticianId) {
    logger.warn({ oauthError, hasCode: !!code }, 'Instagram OAuth callback rejected');
    return res.redirect(`${redirectBase}&ig=error`);
  }

  try {
    // Step 1 — exchange code for short-lived user access token
    const tokenRes = await fetch('https://graph.facebook.com/v21.0/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     META_APP_ID,
        client_secret: META_APP_SECRET,
        redirect_uri:  REDIRECT_URI,
        code,
      }),
    });
    const tokenData = await tokenRes.json();

    if (!tokenData.access_token) {
      logger.error({ tokenData }, 'Instagram: code exchange failed');
      return res.redirect(`${redirectBase}&ig=error`);
    }

    const shortLivedToken = tokenData.access_token;

    // Step 2 — exchange for long-lived user access token (60 days)
    const longLivedRes = await fetch(
      `https://graph.facebook.com/v21.0/oauth/access_token` +
      `?grant_type=fb_exchange_token` +
      `&client_id=${META_APP_ID}` +
      `&client_secret=${META_APP_SECRET}` +
      `&fb_exchange_token=${shortLivedToken}`
    );
    const longLivedData = await longLivedRes.json();
    const userToken = longLivedData.access_token || shortLivedToken;

    // Step 3 — get pages the user manages (need a page to publish from)
    const pagesRes = await fetch(
      `https://graph.facebook.com/v21.0/me/accounts?access_token=${userToken}`
    );
    const pagesData = await pagesRes.json();

    if (!pagesData.data?.length) {
      logger.warn({ beauticianId }, 'Instagram OAuth: user has no Facebook Pages');
      return res.redirect(`${redirectBase}&ig=no_page`);
    }

    // Step 4 — find a page with an Instagram Business Account connected
    let instagramAccountId = null;
    let pageAccessToken    = null;
    let pageName           = null;

    for (const page of pagesData.data) {
      const igCheckRes = await fetch(
        `https://graph.facebook.com/v21.0/${page.id}` +
        `?fields=instagram_business_account,name` +
        `&access_token=${page.access_token}`
      );
      const igCheckData = await igCheckRes.json();

      if (igCheckData.instagram_business_account?.id) {
        instagramAccountId = igCheckData.instagram_business_account.id;
        pageAccessToken    = page.access_token;
        pageName           = igCheckData.name || page.name;
        break;
      }
    }

    if (!instagramAccountId) {
      logger.warn({ beauticianId }, 'Instagram OAuth: no Instagram Business Account found on any page');
      return res.redirect(`${redirectBase}&ig=no_ig_account`);
    }

    // Step 5 — store on beautician row
    const { error: updateErr } = await supabase
      .from('beauticians')
      .update({
        instagram_page_id:    instagramAccountId,
        instagram_page_token: pageAccessToken,
        instagram_page_name:  pageName,
      })
      .eq('id', beauticianId);

    if (updateErr) {
      logger.error({ err: updateErr }, 'Instagram: failed to save credentials');
      return res.redirect(`${redirectBase}&ig=error`);
    }

    logger.info({ beauticianId, instagramAccountId, pageName }, 'Instagram Business Account connected');
    res.redirect(`${redirectBase}&ig=success`);

  } catch (err) {
    logger.error({ err }, 'Instagram OAuth callback error');
    res.redirect(`${redirectBase}&ig=error`);
  }
});

// ───────────────────────────────────────────────────────
// GET /api/instagram/status
// Returns connection status for the current beautician.
// ───────────────────────────────────────────────────────
router.get('/status', requireAuth, async (req, res) => {
  try {
    const { data } = await supabase
      .from('beauticians')
      .select('instagram_page_id, instagram_page_name')
      .eq('id', req.beautician.id)
      .single();

    if (data?.instagram_page_id) {
      res.json({
        connected: true,
        page_name: data.instagram_page_name || 'Instagram',
        account_id: data.instagram_page_id,
      });
    } else {
      res.json({ connected: false });
    }
  } catch (err) {
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// ───────────────────────────────────────────────────────
// POST /api/instagram/disconnect
// Clears the stored Instagram credentials.
// ───────────────────────────────────────────────────────
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
