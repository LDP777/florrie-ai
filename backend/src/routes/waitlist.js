import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import express from 'express';
import { supabase } from '../config.js';
import { normaliseIp } from '../middleware/rate-limit.js';
import { verifyTurnstile } from '../middleware/turnstile.js';
import logger from '../lib/logger.js';
import { waitlistSchema } from '../lib/schemas.js';

const router = Router();
export const WAITLIST_CONSENT_VERSION = 'launch-updates-2026-11-16';
export const WAITLIST_CONSENT_TEXT = 'Email me Florrie launch news and product updates.';
const signupLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30,
  standardHeaders: true, legacyHeaders: false,
  keyGenerator: req => normaliseIp(req.ip || req.socket?.remoteAddress || 'unknown'),
  validate: { ip: false },
  message: { error: 'Please wait a few minutes before trying again.' },
});
const captchaConfig = () => ({ required: process.env.TURNSTILE_ENFORCE === 'true',
  siteKey: process.env.TURNSTILE_SITE_KEY || process.env.VITE_TURNSTILE_SITE_KEY || '' });

router.get('/config', (_req, res) => {
  const config = captchaConfig();
  res.set('Cache-Control', 'no-store');
  if (config.required && (!config.siteKey || !process.env.TURNSTILE_SECRET_KEY)) {
    return res.status(503).json({ error: 'Signup is temporarily unavailable. Please try again shortly.' });
  }
  res.json(config);
});

router.post('/', signupLimiter, (req, res, next) => {
  const config = captchaConfig();
  if (config.required && (!config.siteKey || !process.env.TURNSTILE_SECRET_KEY)) {
    return res.status(503).json({ error: 'Signup is temporarily unavailable. Please try again shortly.' });
  }
  next();
}, verifyTurnstile, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { email, name, marketingConsent, website, attribution } = waitlistSchema.parse(req.body);
    if (website) return res.status(400).json({ error: 'Please leave the website field empty.' });
    // Preserve the first signup and any later unsubscribe. Retrying a slow
    // request must neither duplicate a subscriber nor reinstate an opt-out.
    const { error } = await supabase.from('waitlist_signups').upsert({
      email, name, source: 'landing_page', signed_up_at: new Date().toISOString(),
      marketing_consent_at: marketingConsent ? new Date().toISOString() : null,
      consent_version: WAITLIST_CONSENT_VERSION, consent_text: WAITLIST_CONSENT_TEXT,
      attribution,
    }, { onConflict: 'email', ignoreDuplicates: true }).abortSignal(AbortSignal.timeout(7000));
    if (error) {
      logger.error({ code: error.code }, 'Waitlist signup storage failed');
      return res.status(503).json({ error: 'We could not confirm your signup. Please try again.' });
    }
    // The row's durable welcome queue is processed separately. Neither a
    // provider timeout nor a process restart can invalidate this capture.
    return res.json({ success: true, message: 'Thanks for your interest in Florrie.' });
  } catch (err) {
    if (err.name === 'ZodError') return res.status(400).json({ error: (err.issues || err.errors)[0]?.message || 'Please check your details.' });
    logger.error({ name: err.name }, 'Waitlist signup could not be confirmed');
    return res.status(503).json({ error: 'We could not confirm your signup. Please try again.' });
  }
});

const validToken = token => typeof token === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token);
const page = (title, body) => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${title} | Florrie</title><body style="background:#fbf7f2;color:#382d2e;font-family:system-ui;padding:32px;max-width:560px;margin:10vh auto"><h1>${title}</h1>${body}<p><a href="https://florrie.ai">Back to Florrie</a></p></body></html>`;
// A mail scanner following a link must not unsubscribe someone. GET only
// presents the confirmation; an explicit POST changes the preference.
router.get('/unsubscribe', (req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  if (!validToken(req.query.token)) return res.status(400).send(page('Check your unsubscribe link', '<p>Please use the complete link in your email.</p>'));
  res.send(page('Stop Florrie launch emails?', `<p>You can stop launch news and product updates below.</p><form method="post"><input type="hidden" name="token" value="${req.query.token}"><button type="submit" style="padding:14px 22px">Unsubscribe</button></form>`));
});
router.post('/unsubscribe', express.urlencoded({ extended: false, limit: '2kb' }), async (req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  // Email clients can POST the standard one-click body to the header URL.
  const token = req.body.token || (req.body['List-Unsubscribe'] === 'One-Click' ? req.query.token : null);
  if (!validToken(token)) return res.status(400).send(page('Check your unsubscribe link', '<p>Please use the complete link in your email.</p>'));
  try {
    const { error } = await supabase.from('waitlist_signups').update({ unsubscribed_at: new Date().toISOString() })
      .eq('unsubscribe_token', token).is('unsubscribed_at', null).abortSignal(AbortSignal.timeout(7000));
    if (error) throw new Error('storage_failed');
    res.send(page('You’re unsubscribed', '<p>You will not receive Florrie launch news or product updates from this list.</p>'));
  } catch {
    res.status(503).send(page('Please try again', '<p>We could not save your preference. Try again, or email <a href="mailto:levi@florrie.ai">levi@florrie.ai</a>.</p>'));
  }
});

export default router;
