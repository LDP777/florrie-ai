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

/**
 * Verifies a Cloudflare Turnstile token submitted with a form.
 * Expects `cf-turnstile-response` field in the request body.
 *
 * Skip verification in dev/test if TURNSTILE_SECRET_KEY is not set.
 */
export async function verifyTurnstile(req, res, next) {
  const secretKey = process.env.TURNSTILE_SECRET_KEY;

  // Dev mode: skip if no secret key configured
  if (!secretKey) {
    logger.warn('Turnstile secret key not set — skipping CAPTCHA verification (dev mode)');
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
