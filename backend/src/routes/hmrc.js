/**
 * HMRC Making Tax Digital routes.
 *
 * GET  /api/hmrc/summary/:taxYear/:quarter — quarterly summary preview
 * POST /api/hmrc/submit/:taxYear/:quarter  — submit to HMRC
 * GET  /api/hmrc/auth — redirect to HMRC OAuth
 * GET  /api/hmrc/callback — OAuth callback (exchanges code for tokens)
 * GET  /api/hmrc/status — check if HMRC is linked
 */
import { Router } from 'express';
import { supabase } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import {
  buildQuarterlySummary,
  submitQuarterlyUpdate,
  getHMRCAuthUrl,
  exchangeHMRCCode,
} from '../services/hmrc-mtd.js';
import { signOAuthState, inspectOAuthState, oauthStateSecretProblem } from '../lib/oauth-state.js';
import logger from '../lib/logger.js';

const router = Router();
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://app.florrie.ai';

/**
 * GET /api/hmrc/status — check HMRC link status
 */
router.get('/status', requireAuth, async (req, res) => {
  const { data } = await supabase
    .from('beauticians')
    .select('hmrc_nino, hmrc_access_token')
    .eq('id', req.beautician.id)
    .single();

  res.json({
    linked: !!(data?.hmrc_nino && data?.hmrc_access_token),
    nino: data?.hmrc_nino ? `${data.hmrc_nino.slice(0, 2)}****${data.hmrc_nino.slice(-1)}` : null,
  });
});

/**
 * GET /api/hmrc/summary/:taxYear/:quarter — preview quarterly summary
 * e.g. /api/hmrc/summary/2025-26/0 (Q1, Apr-Jul)
 */
router.get('/summary/:taxYear/:quarter', requireAuth, async (req, res) => {
  try {
    const { taxYear, quarter } = req.params;
    const qi = parseInt(quarter);
    if (isNaN(qi) || qi < 0 || qi > 3) {
      return res.status(400).json({ error: 'Quarter must be 0-3' });
    }

    const summary = await buildQuarterlySummary(req.beautician.id, taxYear, qi);
    res.json(summary);
  } catch (err) {
    logger.error({ err }, 'HMRC summary failed');
    res.status(500).json({ error: 'Failed to build quarterly summary' });
  }
});

/**
 * POST /api/hmrc/submit/:taxYear/:quarter — submit quarterly update to HMRC
 */
router.post('/submit/:taxYear/:quarter', requireAuth, async (req, res) => {
  try {
    const { taxYear, quarter } = req.params;
    const qi = parseInt(quarter);
    if (isNaN(qi) || qi < 0 || qi > 3) {
      return res.status(400).json({ error: 'Quarter must be 0-3' });
    }

    const summary = await buildQuarterlySummary(req.beautician.id, taxYear, qi);
    const result = await submitQuarterlyUpdate(req.beautician.id, summary);

    if (result.success) {
      res.json({ submitted: true, submissionId: result.submissionId, summary });
    } else {
      res.status(result.reason === 'not_configured' ? 503 : 400).json({
        submitted: false,
        reason: result.reason,
        message: result.message || 'Submission failed',
        errors: result.errors,
      });
    }
  } catch (err) {
    logger.error({ err }, 'HMRC submit failed');
    res.status(500).json({ error: 'Submission failed' });
  }
});

/**
 * GET /api/hmrc/auth — redirect beautician to HMRC OAuth
 */
router.get('/auth', requireAuth, (req, res) => {
  const secretProblem = oauthStateSecretProblem();
  if (secretProblem) {
    logger.error({ integration: 'hmrc' }, secretProblem);
    return res.status(503).json({ error: secretProblem });
  }

  const redirectUri = `${FRONTEND_URL}/api/hmrc/callback`;
  const url = getHMRCAuthUrl(req.beautician.id, redirectUri);

  // getHMRCAuthUrl still base64url encodes { beauticianId } on its own, and it
  // is shared with other callers, so the state is swapped for a signed one here
  // instead. Only the state parameter is touched: rebuilding the url through
  // URLSearchParams would also re-encode the scope, and HMRC compares strings.
  const signed = signOAuthState({ beauticianId: req.beautician.id });
  const withSignedState = /[?&]state=/.test(url)
    ? url.replace(/([?&]state=)[^&]*/, `$1${encodeURIComponent(signed)}`)
    : `${url}&state=${encodeURIComponent(signed)}`;

  res.json({ url: withSignedState });
});

/**
 * GET /api/hmrc/callback — HMRC OAuth callback
 * Exchanges auth code for access/refresh tokens and stores them.
 */
router.get('/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) {
      return res.redirect(`${FRONTEND_URL}/settings?hmrc=error&reason=missing_code`);
    }

    // The id comes out of a signature we made. Base64 is not a signature: the
    // old decode here would happily accept a state anybody had assembled, and
    // write HMRC tokens onto whichever row it named.
    const checked = inspectOAuthState(state);
    if (!checked.ok || !checked.payload.beauticianId) {
      logger.warn(
        {
          integration: 'hmrc',
          reason: checked.reason || 'no_beautician_id',
          stateLength: typeof state === 'string' ? state.length : 0,
        },
        'HMRC OAuth callback refused: the state did not verify',
      );
      return res.redirect(`${FRONTEND_URL}/settings?hmrc=error&reason=state`);
    }
    const { beauticianId } = checked.payload;
    const redirectUri = `${FRONTEND_URL}/api/hmrc/callback`;

    const tokens = await exchangeHMRCCode(code, redirectUri);

    // Store tokens
    await supabase
      .from('beauticians')
      .update({
        hmrc_access_token: tokens.access_token,
        hmrc_refresh_token: tokens.refresh_token,
        hmrc_token_expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
      })
      .eq('id', beauticianId);

    res.redirect(`${FRONTEND_URL}/settings?hmrc=success`);
  } catch (err) {
    logger.error({ err }, 'HMRC OAuth callback failed');
    res.redirect(`${FRONTEND_URL}/settings?hmrc=error&reason=token_exchange`);
  }
});

export default router;
