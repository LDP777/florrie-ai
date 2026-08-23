/**
 * Security middleware for Florrie API.
 *
 * Layers:
 *  1. Helmet-style headers (CSP, HSTS, X-Frame-Options, etc.)
 *  2. Stripe-specific payment rate limiter (tighter than general booking limiter)
 *  3. Request sanitisation (strip __proto__, constructor pollution)
 *  4. Idempotency enforcement for payment endpoints
 *  5. Cron key enforcement that fails CLOSED when the secret is unset
 */
import crypto from 'node:crypto';
import rateLimit from 'express-rate-limit';
import logger from '../lib/logger.js';

export function securityHeaders(req, res, next) {
  // Content Security Policy — only allow Stripe's JS for payment frames
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' https://js.stripe.com",
    "frame-src 'self' https://js.stripe.com https://hooks.stripe.com",
    "connect-src 'self' https://api.stripe.com https://*.supabase.co",
    "img-src 'self' data: https:",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '));

  // Strict Transport Security — force HTTPS for 1 year
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');

  // Prevent clickjacking
  res.setHeader('X-Frame-Options', 'DENY');

  // Prevent MIME sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Referrer policy — don't leak full URL to Stripe or other origins
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Permissions policy — disable unused browser features
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(self "https://js.stripe.com")');

  // Remove server header
  res.removeHeader('X-Powered-By');

  next();
}

// Tighter than booking limiter: max 5 payment attempts per 15 min per IP
export const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Key by authenticated user when present so a beautician testing their own
    // Stripe connection isn't throttled against a shared 'global' bucket;
    // fall back to IP + booking slug for public booking-page traffic.
    const who = req.user?.id || req.ip;
    return `${who}:${req.params.slug || 'global'}`;
  },
  message: { error: 'Too many payment attempts. Please wait 15 minutes before trying again.' },
  handler: (req, res) => {
    logger.warn({ ip: req.ip, path: req.path }, 'Payment rate limit exceeded');
    res.status(429).json({ error: 'Too many payment attempts. Please wait 15 minutes before trying again.' });
  },
});

// Strips dangerous keys from request bodies before they hit route handlers
export function sanitiseBody(req, res, next) {
  // Raw webhook bodies arrive as Buffers (typeof === 'object'); iterating their
  // byte indices is a pointless ~1MB scan per Stripe webhook, so skip them (L1).
  if (Buffer.isBuffer(req.body)) return next();
  if (req.body && typeof req.body === 'object') {
    stripDangerousKeys(req.body);
  }
  next();
}

function stripDangerousKeys(obj) {
  if (!obj || typeof obj !== 'object') return;
  const dangerous = ['__proto__', 'constructor', 'prototype'];
  for (const key of Object.keys(obj)) {
    if (dangerous.includes(key)) {
      delete obj[key];
      continue;
    }
    if (typeof obj[key] === 'object' && obj[key] !== null) {
      stripDangerousKeys(obj[key]);
    }
  }
}

// ── Idempotency ───────────────────────────────────────────────────────────
//
// The original guard only fired when the CALLER sent an Idempotency-Key
// header. Nothing in the Florrie app sends one, so on the paths that move real
// money the guard was decoration: Ellie tapped Refund, the button did not
// visibly respond, she tapped again, and a second refund went out.
//
// So the key is now derived SERVER SIDE for the paths where a repeat is
// always a mistake. It is deliberately not derived for every payment path:
// re-posting /connect/onboard or /save-card-link is a normal thing to do and
// must keep working.
//
// This map is per process and is wiped by a deploy, so it is a fast local
// backstop, not the guarantee. The guarantee is the idempotencyKey the refund
// route hands to Stripe, which holds across processes and restarts.
const recentPaymentKeys = new Map(); // key -> timestamp
const IDEMPOTENCY_WINDOW = 5 * 60 * 1000; // 5 minutes

// Paths (relative to the router this guard is mounted on) where the server
// derives a key when the caller did not send one.
const SERVER_DERIVED_PATHS = new Set(['/refund']);

/** JSON with object keys sorted, so two identical bodies hash identically. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/**
 * A stable key for "this caller asking for this exact thing".
 *
 * Same signed-in user, same path, same body => same key. That is precisely a
 * double tap. A different amount, a different appointment, or a different
 * person produces a different key and is let through.
 *
 * @param {object} req
 * @returns {string}
 */
export function deriveIdempotencyKey(req) {
  // This guard is mounted app-side, BEFORE requireAuth, so req.beautician is
  // usually not populated yet. The bearer token identifies the caller just as
  // well and is hashed, never stored in the clear. IP is the last resort, and
  // is only reached by unauthenticated callers.
  const auth = typeof req.headers?.authorization === 'string' ? req.headers.authorization : '';
  const who = req.user?.id
    || req.beautician?.id
    || (auth ? `tok:${crypto.createHash('sha256').update(auth).digest('hex').slice(0, 16)}` : '')
    || `ip:${req.ip || 'anon'}`;
  const body = req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : {};
  const digest = crypto.createHash('sha256')
    .update(`${req.method}\n${req.baseUrl || ''}${req.path}\n${who}\n${canonical(body)}`)
    .digest('hex')
    .slice(0, 32);
  return `derived:${digest}`;
}

export function idempotencyGuard(req, res, next) {
  const headerKey = req.headers['idempotency-key'];
  const derived = !headerKey && SERVER_DERIVED_PATHS.has(req.path);
  const key = headerKey || (derived ? deriveIdempotencyKey(req) : null);

  // Nothing to key on: a path we do not derive for, and no header. Stripe
  // still applies its own idempotency on the calls that pass one.
  if (!key) return next();

  const existing = recentPaymentKeys.get(key);
  if (existing && Date.now() - existing < IDEMPOTENCY_WINDOW) {
    logger.warn({ key, derived, ip: req.ip, path: req.path }, 'Duplicate payment request blocked');
    return res.status(409).json({ error: 'This payment request has already been submitted. Please wait a moment.' });
  }

  recentPaymentKeys.set(key, Date.now());

  // A first attempt that FAILED must not lock the caller out for five
  // minutes. Release the key unless the request actually succeeded. If the
  // failure happened after Stripe had already done the work, the route's own
  // Stripe idempotency key still stops a second one being created.
  res.on('finish', () => {
    if (res.statusCode >= 400) recentPaymentKeys.delete(key);
  });

  // Clean up old keys every 100 requests
  if (recentPaymentKeys.size > 500) {
    const cutoff = Date.now() - IDEMPOTENCY_WINDOW;
    for (const [k, ts] of recentPaymentKeys) {
      if (ts < cutoff) recentPaymentKeys.delete(k);
    }
  }

  next();
}

/** Test seam: forget every remembered key. Not used by the running server. */
export function resetIdempotencyKeys() {
  recentPaymentKeys.clear();
}

// ── Cron authentication ───────────────────────────────────────────────────
//
// WHY THIS EXISTS. Both cron endpoints used to inline this:
//
//   if (req.headers['x-cron-key'] !== process.env.CRON_SECRET) return 401;
//
// With CRON_SECRET unset on the server that is `undefined !== undefined`,
// which is false, so the handler ran for ANYBODY who sent no header at all.
// POST /api/notifications/process-reminders would then fire the 24 hour
// reminder pass for every tenant on demand, burning the SMS allowance and
// re-texting clients who had already been told.
//
// CRON_SECRET is not in REQUIRED_ENV and must not be: a feature scoped
// variable in that list takes the whole server down at boot. So the check has
// to fail CLOSED here instead. No secret configured means the endpoint is not
// available, and that is loud in the logs rather than silent.

/** Constant time compare that does not leak the secret's length. */
function secretsMatch(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Express middleware for the x-cron-key protected endpoints.
 *
 * Refuses when the secret is unset, when the header is missing, and when the
 * header does not match. There is no combination of inputs that lets an
 * unauthenticated caller through.
 */
export function requireCronKey(req, res, next) {
  const expected = process.env.CRON_SECRET;

  if (typeof expected !== 'string' || expected.trim() === '') {
    logger.error({ path: req.originalUrl || req.path },
      'CRON_SECRET is not set; cron endpoint refused. Set CRON_SECRET to enable it.');
    return res.status(503).json({ error: 'Cron endpoints are not configured on this server.' });
  }

  const provided = req.headers['x-cron-key'];
  if (!secretsMatch(typeof provided === 'string' ? provided : '', expected.trim())) {
    logger.warn({ ip: req.ip, path: req.originalUrl || req.path }, 'Cron key rejected');
    return res.status(401).json({ error: 'Invalid cron key' });
  }

  return next();
}
