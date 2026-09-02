/**
 * Cloudflare Turnstile CAPTCHA verification middleware.
 * Apply to public form submission endpoints to prevent bot abuse.
 *
 * Setup:
 *   1. Go to https://dash.cloudflare.com → Turnstile → Add site
 *   2. Add florrie.ai as the hostname
 *   3. Copy Site Key → TURNSTILE_SITE_KEY (frontend .env)
 *   4. Copy Secret Key → TURNSTILE_SECRET_KEY (backend .env)
 */
import logger from '../lib/logger.js';

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

// Said once per process. A secret key in the environment reads as "CAPTCHA is
// on" to anyone checking the Railway variables, and until 2 September 2026
// nothing contradicted that: the flag below returned early in silence, so a
// configured-but-unenforced Turnstile looked identical to an enforced one.
// One warning on the first request makes the gap visible in the logs.
let warnedNotEnforced = false;

/**
 * Verifies a Cloudflare Turnstile token submitted with a form.
 * Expects `cf-turnstile-response` field in the request body.
 *
 * Skip verification in dev/test if TURNSTILE_SECRET_KEY is not set.
 */
export async function verifyTurnstile(req, res, next) {
  const secretKey = process.env.TURNSTILE_SECRET_KEY;
  const enforce = process.env.TURNSTILE_ENFORCE === 'true';

  // Feature flag: only enforce when explicitly enabled. The frontend booking page
  // does not yet ship a Turnstile widget, so enforcing by default would reject all
  // public booking submissions. Flip TURNSTILE_ENFORCE=true once the widget is wired.
  if (!enforce) {
    if (secretKey && !warnedNotEnforced) {
      warnedNotEnforced = true;
      logger.warn('TURNSTILE_SECRET_KEY is set but TURNSTILE_ENFORCE is not "true": CAPTCHA is configured and NOT being checked');
    }
    return next();
  }

  // Dev mode: skip if no secret key configured
  if (!secretKey) {
    logger.warn('Turnstile secret key not set, skipping CAPTCHA verification (dev mode)');
    return next();
  }

  const token = req.body?.['cf-turnstile-response'];

  if (!token) {
    return res.status(400).json({ error: 'CAPTCHA verification required' });
  }

  try {
    const formData = new URLSearchParams({
      secret: secretKey,
      response: token,
      remoteip: req.ip,
    });

    const response = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      body: formData,
    });

    const result = await response.json();

    if (!result.success) {
      logger.warn({ codes: result['error-codes'], ip: req.ip }, 'Turnstile verification failed');
      return res.status(400).json({ error: 'CAPTCHA verification failed. Please try again.' });
    }

    next();
  } catch (err) {
    logger.error({ err }, 'Turnstile verification request failed');
    // Fail open in case Cloudflare is down — log but don't block legitimate users
    next();
  }
}
