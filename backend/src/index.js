// v0.1.1 , 2026-04-10 redeploy
import * as Sentry from '@sentry/node';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import logger from './lib/logger.js';

// Initialise Sentry before anything else so it captures startup errors too.
// If SENTRY_DSN is not set the SDK is a no-op , safe in all environments.
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    integrations: [
      Sentry.httpIntegration(),
      Sentry.expressIntegration(),
    ],
    // Capture 10% of transactions for performance monitoring
    tracesSampleRate: 0.1,
  });
  logger.info('Sentry initialised');
}
import { apiLimiter, authLimiter, bookingLimiter } from './middleware/rate-limit.js';
import { securityHeaders, paymentLimiter, sanitiseBody, idempotencyGuard } from './middleware/security.js';
import { locationScope } from './middleware/location.js';

// Services
import { processReminders } from './services/notifications.js';
import { cleanupStaleBookings } from './services/cleanup.js';
import { runAutonomousCycle } from './services/autonomous-scheduler.js';
import { autoCompletePastAppointments } from './services/auto-complete.js';
import { runPredictiveNudges } from './services/predictive-nudge.js';
import { runDailyHeartbeats } from './services/florrie-heartbeat.js';
import { processEmailQueue, checkTrialExpiry } from './services/email-sequences.js';
import { processRetryQueue as processWhatsAppRetryQueue } from './services/whatsapp-retry.js';
import { runComeback } from './jobs/comeback.js';
import { cleanupStripeEvents } from './services/stripe-cleanup.js';
import { billMonthlySurplus } from './services/whatsapp-metering.js';

// Routes
import authRoutes from './routes/auth.js';
import treatmentRoutes from './routes/treatments.js';
import clientRoutes from './routes/clients.js';
import appointmentRoutes from './routes/appointments.js';
import bookingRoutes from './routes/booking.js';
import aiActionRoutes from './routes/ai-actions.js';
import activityRoutes from './routes/activity.js';
import inboxRoutes from './routes/inbox.js';
import webhookRoutes from './routes/webhooks.js';
import escalationRoutes from './routes/escalations.js';
import contentRoutes from './routes/content.js';
import moneyRoutes from './routes/money.js';
import stripeRoutes from './routes/stripe.js';
import notificationRoutes from './routes/notifications.js';
import gcalRoutes from './routes/google-calendar.js';
import featureRoutes from './routes/features.js';
import hoursExceptionsRoutes from './routes/hours-exceptions.js';
import exportsRoutes from './routes/exports.js';
import promoCodesRoutes from './routes/promo-codes.js';
import photoConsentRoutes from './routes/photo-consent.js';
import locationsRoutes from './routes/locations.js';
import voiceRoutes from './routes/voice.js';
import consultationFormRoutes from './routes/consultation-forms.js';
import billingRoutes from './routes/billing.js';
import waitlistRoutes from './routes/waitlist.js';
import instagramWebhookRoutes from './routes/instagram-webhooks.js';
import twilioWebhookRoutes from './routes/twilio-webhooks.js';
import instagramRoutes from './routes/instagram.js';
import referralRoutes from './routes/referrals.js';
import pushRoutes from './routes/push.js';
import agentStatusRoutes from './routes/agent-status.js';
import hmrcRoutes from './routes/hmrc.js';
import productRoutes from './routes/products.js';
import migrateRoutes from './routes/migrate.js';
import importAppointmentsRoutes from './routes/import-appointments.js';
import usageRoutes from './routes/usage.js';
import setupRoutes from './routes/setup.js';
import whatsappConfigRoutes from './routes/whatsapp-config.js';
import coachRoutes from './routes/coach.js';
import courseRoutes from './routes/courses.js';
import suggestionsRoutes from './routes/suggestions.js';
import outboundRoutes from './routes/outbound.js';
import calendarRoutes from './routes/calendar.js';

dotenv.config();

const REQUIRED_ENV = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_KEY',
  'FRONTEND_URL',
];
// WhatsApp vars used to be required but that crashed the whole backend when
// unset, taking down features that don't depend on WhatsApp at all. Routes
// under /api/whatsapp/* check for these at request time and return a
// structured error via Sentry if missing.
//
// Each entry is an array of acceptable names. The first set value wins.
// We accept both the short names we ship under and Meta's official names,
// because Railway provisions with the Meta names.
const WHATSAPP_ENV = [
  ['WHATSAPP_TOKEN', 'WHATSAPP_ACCESS_TOKEN'],
  ['WHATSAPP_WABA_ID', 'WHATSAPP_BUSINESS_ACCOUNT_ID'],
  ['WHATSAPP_VERIFY_TOKEN'], // webhook handshake; unset => verify endpoint 503s
];
const OPTIONAL_ENV = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'RESEND_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'ENCRYPTION_KEY',
  'BIRD_API_KEY',        // outbound SMS via MessageBird
  'BIRD_ORIGINATOR',     // default sender (phone number for 2-way, alpha for 1-way)
  'BIRD_WEBHOOK_TOKEN',  // query-param auth for inbound POST /api/webhooks/bird-sms
  'WHATSAPP_APP_SECRET', // (or META_APP_SECRET) HMAC verify for WhatsApp webhooks
  'META_APP_SECRET',     // Facebook/Instagram app secret
  'INSTAGRAM_APP_SECRET',// HMAC verify for Instagram webhooks
  'TWILIO_AUTH_TOKEN',   // Twilio webhook signatures + WhatsApp BSP auth
  'TWILIO_ACCOUNT_SID',  // Twilio WhatsApp BSP (wa_provider='twilio' tenants)
  'TWILIO_CONTENT_SIDS', // JSON map templateName -> Twilio ContentSid (HX...)
];

const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  logger.fatal({ missing }, 'Missing required env vars');
  process.exit(1);
}

const whatsappMissing = WHATSAPP_ENV
  .filter(names => !names.some(n => process.env[n]))
  .map(names => names.join(' or '));
if (whatsappMissing.length) {
  logger.error(
    { missing: whatsappMissing },
    'WhatsApp env vars not set; /api/whatsapp/* routes will 503 until configured',
  );
}

const unset = OPTIONAL_ENV.filter(k => !process.env[k]);
if (unset.length) {
  logger.warn({ unset }, 'Optional env vars not set; some features disabled');
}

const app = express();
const PORT = process.env.PORT || 3001;

// Railway / Render / Fly all run behind a reverse proxy
app.set('trust proxy', 1);

// Middleware
app.use(securityHeaders);
// CORS: allow the web app plus the Capacitor native shells (iOS uses
// capacitor://localhost, Android uses https://localhost). Auth is enforced by
// the Bearer token, not CORS, so a permissive-but-explicit allowlist is safe.
const allowedOrigins = [
  process.env.FRONTEND_URL,
  process.env.APP_URL,
  'https://florrie.ai',
  'https://www.florrie.ai',
  'capacitor://localhost',
  'ionic://localhost',
  'https://localhost',
  'http://localhost',
].filter(Boolean);
app.use(cors({
  origin(origin, cb) {
    // No Origin header (native webviews sometimes omit it, health checks, curl) -> allow.
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(null, false);
  },
}));

// Webhook limiter (stricter than general API)
const webhookLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

// Raw body for Stripe webhook signature verification
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }), (req, res, next) => {
  req.rawBody = req.body;
  next();
});
app.use('/api/billing/webhook', express.raw({ type: 'application/json' }));

// Stash the raw request body on req.rawBody for routes that need to verify
// HMAC signatures against the exact bytes the sender signed. Meta (WhatsApp,
// Instagram) signs the raw JSON; re-serialising via JSON.stringify(req.body)
// is unreliable because key ordering and number formatting can drift.
app.use(express.json({
  limit: '1mb',
  verify: (req, _res, buf) => {
    if (buf && buf.length) req.rawBody = buf;
  },
}));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(sanitiseBody);
app.use(locationScope);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'florrie-api', version: '0.1.0' });
});

// API routes
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/treatments', apiLimiter, treatmentRoutes);
app.use('/api/clients', apiLimiter, clientRoutes);
app.use('/api/appointments', apiLimiter, appointmentRoutes);
app.use('/api/booking', bookingLimiter, bookingRoutes); // public booking page API
app.use('/api/ai-actions', apiLimiter, aiActionRoutes);
app.use('/api/activity', apiLimiter, activityRoutes);
app.use('/api/inbox', apiLimiter, inboxRoutes);
app.use('/api/webhooks', webhookLimiter, webhookRoutes); // WhatsApp + Twilio + Bird SMS inbound webhooks
app.use('/api/escalations', apiLimiter, escalationRoutes);
app.use('/api/content', apiLimiter, contentRoutes);
app.use('/api/money', apiLimiter, moneyRoutes);
// Stripe webhook must bypass rate limiter + idempotency guard , Stripe retries
// from many IPs and doesn't send Idempotency-Key headers. The webhook handler
// does its own idempotency check via the stripe_events table.
app.use('/api/stripe', (req, res, next) => {
  if (req.path === '/webhook') return next();
  paymentLimiter(req, res, next);
}, (req, res, next) => {
  if (req.path === '/webhook') return next();
  idempotencyGuard(req, res, next);
}, stripeRoutes);
app.use('/api/notifications', apiLimiter, notificationRoutes);
app.use('/api/gcal', apiLimiter, gcalRoutes);
app.use('/api/features', apiLimiter, featureRoutes);
app.use('/api/hours-exceptions', apiLimiter, hoursExceptionsRoutes);
app.use('/api/exports', apiLimiter, exportsRoutes);
// Promo codes: apply bookingLimiter to public routes specifically
app.use('/api/promo-codes', (req, res, next) => {
  // Apply bookingLimiter only to public endpoints (validate endpoint)
  if (req.path === '/validate' && req.method === 'POST') {
    return bookingLimiter(req, res, next);
  }
  // Apply apiLimiter to authenticated endpoints
  return apiLimiter(req, res, next);
}, promoCodesRoutes);
app.use('/api/photo-consent', apiLimiter, photoConsentRoutes);
app.use('/api/locations', apiLimiter, locationsRoutes);
app.use('/api/voice', apiLimiter, voiceRoutes);
app.use('/api/consultation-forms', apiLimiter, consultationFormRoutes);
app.use('/api/billing', (req, res, next) => {
  // Stripe webhook retries from many IPs without Idempotency-Key headers; skip
  // the limiter for it exactly like /api/stripe does (M15). The handler does
  // its own idempotency check.
  if (req.path === '/webhook') return next();
  apiLimiter(req, res, next);
}, billingRoutes);
app.use('/api/waitlist', apiLimiter, waitlistRoutes);
app.use('/api/referrals', apiLimiter, referralRoutes);
app.use('/api/push', apiLimiter, pushRoutes);
app.use('/api/agents', apiLimiter, agentStatusRoutes);
app.use('/api/hmrc', apiLimiter, hmrcRoutes);
app.use('/api/products', apiLimiter, productRoutes);
app.use('/api/migrate', apiLimiter, migrateRoutes);
app.use('/api/import', apiLimiter, importAppointmentsRoutes); // Timely appointment CSV import
app.use('/api/usage', apiLimiter, usageRoutes);
app.use('/api/setup', apiLimiter, setupRoutes);
app.use('/api/whatsapp', apiLimiter, whatsappConfigRoutes);
app.use('/api/webhooks/instagram', webhookLimiter, instagramWebhookRoutes);
app.use('/api/webhooks/twilio', webhookLimiter, twilioWebhookRoutes); // Twilio BSP WhatsApp inbound
app.use('/api/coach', apiLimiter, coachRoutes);
app.use('/api/instagram', apiLimiter, instagramRoutes);
app.use('/api/courses', bookingLimiter, courseRoutes); // public course enrollment API
app.use('/api/suggestions', apiLimiter, suggestionsRoutes);
app.use('/api/outbound', apiLimiter, outboundRoutes); // Florrie's outbox: review/approve proactive sends
app.use('/api/calendar', apiLimiter, calendarRoutes); // private iCal subscribe feed + sync URLs

// Sentry error handler , must come after all routes, before the generic handler
if (process.env.SENTRY_DSN) {
  Sentry.setupExpressErrorHandler(app);
}

// Generic error handler
app.use((err, req, res, next) => {
  logger.error({ err }, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  logger.info({ port: PORT }, 'Florrie API started');

  // Run 24h appointment reminders every hour
  // Finds appointments in a 1-hour window around the 24h mark and sends reminders
  const REMINDER_INTERVAL = 60 * 60 * 1000; // 1 hour
  setInterval(async () => {
    try {
      const result = await processReminders();
      if (result.sent > 0) {
        logger.info({ sent: result.sent, total: result.total }, 'Reminder cron: sent appointment reminders');
      }
    } catch (err) {
      logger.error({ err }, 'Reminder cron: processing failed');
    }
  }, REMINDER_INTERVAL);

  // NOTE: deliberately NOT running processReminders() on startup. It used to run
  // on every boot "to catch missed reminders", but combined with frequent deploys
  // that re-sent the same 24h reminder repeatedly. The hourly interval (plus the
  // per-appointment idempotency guard in notifyReminder24h) covers everything
  // within an hour, which is fine for a reminder sent a day ahead.

  // Auto-cancel unpaid deposit bookings after 15 minutes
  const CLEANUP_INTERVAL = 5 * 60 * 1000; // check every 5 minutes
  setInterval(async () => {
    try {
      const result = await cleanupStaleBookings();
      if (result.cancelled > 0) {
        logger.info({ cancelled: result.cancelled }, 'Cleanup cron: cancelled stale unpaid bookings');
      }
    } catch (err) {
      logger.error({ err }, 'Cleanup cron: booking cleanup failed');
    }
  }, CLEANUP_INTERVAL);

  // Run cleanup on startup
  cleanupStaleBookings().then(r => {
    if (r?.cancelled > 0) logger.info({ cancelled: r.cancelled }, 'Startup: cancelled stale bookings');
  }).catch(() => {});

  // Florrie autonomous scheduler , rebook nudges, gap posts, unanswered messages
  const AUTONOMOUS_INTERVAL = 2 * 60 * 60 * 1000; // every 2 hours
  setInterval(async () => {
    try {
      await runAutonomousCycle();
    } catch (err) {
      logger.error({ err }, 'Autonomous cron: cycle failed');
    }
  }, AUTONOMOUS_INTERVAL);

  // Run first autonomous cycle 30s after startup (let DB connections settle)
  setTimeout(() => {
    runAutonomousCycle().catch(err => {
      logger.error({ err }, 'Startup: autonomous cycle failed');
    });
  }, 30_000);

  // Predictive nudges , daily at startup, then every 24 hours
  const PREDICTIVE_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours
  setInterval(async () => {
    try {
      await runPredictiveNudges();
    } catch (err) {
      logger.error({ err }, 'Predictive nudge cron: failed');
    }
  }, PREDICTIVE_INTERVAL);

  // Run first predictive scan 60s after startup
  setTimeout(() => {
    runPredictiveNudges().catch(err => {
      logger.error({ err }, 'Startup: predictive nudge scan failed');
    });
  }, 60_000);

  // Auto-complete past appointments: assume each one happened (mark completed +
  // log takings) unless the beautician flags a no-show. Frequent so it feels
  // instant; the sweep itself only touches appointments that ended in the last
  // 48h and is idempotent. See services/auto-complete.js.
  const AUTO_COMPLETE_INTERVAL = 10 * 60 * 1000; // every 10 minutes
  setInterval(async () => {
    try {
      await autoCompletePastAppointments();
    } catch (err) {
      logger.error({ err }, 'Auto-complete cron: failed');
    }
  }, AUTO_COMPLETE_INTERVAL);

  // Run first sweep 45s after startup
  setTimeout(() => {
    autoCompletePastAppointments().catch(err => {
      logger.error({ err }, 'Startup: auto-complete sweep failed');
    });
  }, 45_000);

  // Florrie heartbeat: once-daily passive checks that log real numbers to
  // ai_actions so the Hub "What Florrie did" feed stays populated with truthful
  // entries. See backend/src/services/florrie-heartbeat.js for the five checks.
  // Idempotent — a beautician only gets one heartbeat per calendar day.
  const HEARTBEAT_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours
  setInterval(async () => {
    try {
      await runDailyHeartbeats();
    } catch (err) {
      logger.error({ err }, 'Heartbeat cron: failed');
    }
  }, HEARTBEAT_INTERVAL);

  // Run first heartbeat 30s after startup, so the feed gets fresh real rows
  // shortly after a Railway deploy/restart.
  setTimeout(() => {
    runDailyHeartbeats().catch(err => {
      logger.error({ err }, 'Startup: heartbeat run failed');
    });
  }, 75_000); // M8: sits between predictive (60s) and WhatsApp retry (90s) to avoid a startup CPU/pool spike

  // Email sequence queue , process due emails every 15 minutes
  const EMAIL_QUEUE_INTERVAL = 15 * 60 * 1000; // 15 minutes
  setInterval(async () => {
    try {
      const result = await processEmailQueue();
      if (result.sent > 0) logger.info(result, 'Email queue: processed');
    } catch (err) {
      logger.error({ err }, 'Email queue cron: failed');
    }
  }, EMAIL_QUEUE_INTERVAL);

  // Trial expiry check , daily, triggers warning emails for expiring trials
  const TRIAL_CHECK_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours
  setInterval(async () => {
    try {
      const result = await checkTrialExpiry();
      if (result.triggered > 0) logger.info(result, 'Trial expiry: triggered sequences');
    } catch (err) {
      logger.error({ err }, 'Trial expiry cron: failed');
    }
  }, TRIAL_CHECK_INTERVAL);

  // Run email queue 45s after startup
  setTimeout(() => {
    processEmailQueue().catch(err => {
      logger.error({ err }, 'Startup: email queue processing failed');
    });
  }, 45_000);

  // WhatsApp registration retry queue: picks up cooldowns once Meta has
  // released them, and polls pending-activation numbers until they flip to
  // CONNECTED. 5 minutes balances 1h rate-limits (need tight polling) with
  // 24h cooldowns (no harm checking more often).
  const WHATSAPP_RETRY_INTERVAL = 5 * 60 * 1000; // 5 minutes
  setInterval(async () => {
    try {
      const result = await processWhatsAppRetryQueue();
      if (result.processed > 0) {
        logger.info(result, 'WhatsApp retry cron: processed queue');
      }
    } catch (err) {
      logger.error({ err }, 'WhatsApp retry cron: failed');
    }
  }, WHATSAPP_RETRY_INTERVAL);

  // Run once 90s after startup so deploys don't eat queued retries.
  setTimeout(() => {
    processWhatsAppRetryQueue().catch(err => {
      logger.error({ err }, 'Startup: WhatsApp retry queue pass failed');
    });
  }, 90_000);

  // ── Revenue + maintenance crons (ported off Railway/Cowork scheduling, C5) ──
  const REVENUE_CRON_INTERVAL = 24 * 60 * 60 * 1000; // daily; all three are idempotent

  // Comeback engine — re-engage lapsed clients.
  setInterval(() => {
    runComeback().catch(err => logger.error({ err }, 'Comeback cron: failed'));
  }, REVENUE_CRON_INTERVAL);
  setTimeout(() => {
    runComeback().catch(err => logger.error({ err }, 'Startup: comeback pass failed'));
  }, 120_000);

  // Message surplus billing — bill completed months over the 120/month combined
  // (SMS + WhatsApp) allowance, charged via Stripe invoice items. Idempotent.
  // Daily interval only. The per-boot run was removed: frequent deploys meant
  // many billing passes a day. Rows are claimed optimistically (billed=true
  // gated on billed=false) so an overlap can never double-bill, and a daily
  // cadence is fine for billing a frozen past month.
  setInterval(() => {
    billMonthlySurplus()
      .then(r => { if (r) logger.info({ r }, 'Monthly surplus billing cron: done'); })
      .catch(err => logger.error({ err }, 'Monthly surplus billing cron: failed'));
  }, REVENUE_CRON_INTERVAL);

  // Stripe events cleanup — prune stripe_events rows past TTL.
  setInterval(() => {
    cleanupStripeEvents()
      .then(r => { if (r) logger.info({ r }, 'Stripe cleanup cron: done'); })
      .catch(err => logger.error({ err }, 'Stripe cleanup cron: failed'));
  }, REVENUE_CRON_INTERVAL);
  setTimeout(() => {
    cleanupStripeEvents().catch(err => logger.error({ err }, 'Startup: stripe cleanup failed'));
  }, 180_000);
});
