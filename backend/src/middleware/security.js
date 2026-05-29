/**
 * Security middleware for Florrie API.
 *
 * Layers:
 *  1. Helmet-style headers (CSP, HSTS, X-Frame-Options, etc.)
 *  2. Stripe-specific payment rate limiter (tighter than general booking limiter)
 *  3. Request sanitisation (strip __proto__, constructor pollution)
 *  4. Idempotency enforcement for payment endpoints
 */
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

// Clients send Idempotency-Key header; we reject duplicates within a window.
// This prevents double-charging if a user clicks "Pay" twice.
const recentPaymentKeys = new Map(); // key -> timestamp
const IDEMPOTENCY_WINDOW = 5 * 60 * 1000; // 5 minutes

export function idempotencyGuard(req, res, next) {
  const key = req.headers['idempotency-key'];
  if (!key) return next(); // optional — Stripe handles its own idempotency too

  const existing = recentPaymentKeys.get(key);
  if (existing && Date.now() - existing < IDEMPOTENCY_WINDOW) {
    logger.warn({ key, ip: req.ip }, 'Duplicate payment request blocked');
    return res.status(409).json({ error: 'This payment request has already been submitted. Please wait a moment.' });
  }

  recentPaymentKeys.set(key, Date.now());

  // Clean up old keys every 100 requests
  if (recentPaymentKeys.size > 500) {
    const cutoff = Date.now() - IDEMPOTENCY_WINDOW;
    for (const [k, ts] of recentPaymentKeys) {
      if (ts < cutoff) recentPaymentKeys.delete(k);
    }
  }

  next();
}
