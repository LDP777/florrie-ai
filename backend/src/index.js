// v0.1.1 , 2026-04-10 redeploy

// THE PROCESS RUNS ON UTC, AND THAT IS NOT AN ACCIDENT ANY MORE.
//
// appointments.starts_at stores SALON WALL TIME inside a UTC slot, and several
// paths read it back with plain `new Date(...)` arithmetic. Those are correct
// only while the process clock is UTC, which until now was true purely because
// nothing had ever set TZ on Railway. Setting TZ=Europe/London there, or a base
// image shipping a different default, would have shifted reschedules and
// working-hours checks by an hour in BST without a line of code changing.
//
// Set here rather than in Railway's variables so it lives with the code that
// depends on it, and before any import can construct a Date and cache the zone.
process.env.TZ = 'UTC';

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
import { paywall } from './middleware/require-plan.js';

// Background jobs
//
// The job list and the scheduler that runs it live in their own modules. This
// file used to hold fifteen setInterval calls and nine startup setTimeouts,
// none of which recorded whether they ever ran, and two of which almost
// certainly never did. See lib/scheduler.js and jobs/register.js.
import { registerAllJobs } from './jobs/register.js';
import { startScheduler, listJobs } from './lib/scheduler.js';

// Detection layer: heartbeats for the crons and a health endpoint that can
// actually go red. See lib/health.js for why the old one was a lie.
import { runHealthChecks, reportDegraded } from './lib/health.js';
import { probeAuthorshipColumn } from './lib/authorship.js';
import Stripe from 'stripe';

// A client purely for the health check's authenticated Stripe call. Cheap to
// construct; kept here so index.js does not have to import a route's internals.
const healthStripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

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
import recurringExpenseRoutes from './routes/recurring-expenses.js';
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
import florrieThinksRoutes from './routes/florrie-thinks.js';
import outboundRoutes from './routes/outbound.js';
import calendarRoutes from './routes/calendar.js';
import knowledgeRoutes from './routes/knowledge.js';

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
  'TWILIO_CONTENT_SIDS', // JSON map templateName -> Twilio ContentSid (HX...), shared across tenants
  'CRON_SECRET',        // x-cron-key for /api/notifications/process-reminders and /api/stripe/cleanup-events. Unset means both answer 503 rather than running for anybody
  // Added 2 September 2026. Every one of these was read somewhere via
  // process.env and appeared in neither list, so being unset produced no line
  // at boot and a feature that simply did nothing: no Sentry at all, no push,
  // no booking bot protection, every checkout answering "Invalid plan selected".
  'SENTRY_DSN',                  // unset means NO error monitoring, not degraded monitoring
  'STRIPE_PRICE_FLORRIE',        // subscription checkout price ids: unset means every checkout fails
  'STRIPE_PRICE_FLORRIE_ANNUAL',
  'STRIPE_PRICE_FLORRIE_TEAM',
  'STRIPE_PRICE_FLORRIE_TEAM_ANNUAL',
  'VAPID_PUBLIC_KEY',            // web push: unset means the browser push leg is dead
  'VAPID_PRIVATE_KEY',
  'APNS_KEY_ID',                 // native iOS push: unset means no booking alert reaches a phone
  'APNS_TEAM_ID',
  'APNS_PRIVATE_KEY',
  'TURNSTILE_SECRET_KEY',        // booking page bot check
  'INSTAGRAM_APP_ID',            // Instagram Business Login; falls back to localhost without it
  'INSTAGRAM_REDIRECT_URI',
  'BIRD_WORKSPACE_ID',           // falls back to the PILOT SALON's workspace when unset
  'BIRD_SMS_CHANNEL_ID',         // falls back to the PILOT SALON's channel when unset
];

/**
 * Settings that change what the service DOES rather than whether a feature
 * exists. Logged at boot by value, because their effect is invisible
 * otherwise: on 1 September the inbound webhooks were found to be processing
 * unsigned payloads in production because a fail-closed flag had never been
 * set anywhere, and nothing at boot said so.
 */
const BEHAVIOUR_FLAGS = [
  'WEBHOOK_ALLOW_UNSIGNED',      // 'true' means inbound webhooks accept payloads with no signature. Local development ONLY
  'TURNSTILE_ENFORCE',           // 'true' means the booking page requires a passed bot check
  'STRIPE_TEAM_PRICE_PER_SEAT',  // set means the team plan bills per active staff member
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

const flags = Object.fromEntries(BEHAVIOUR_FLAGS.map(k => [k, process.env[k] ?? '(unset)']));
logger.info({ flags }, 'Behaviour flags at boot');
if (process.env.WEBHOOK_ALLOW_UNSIGNED === 'true' && process.env.NODE_ENV === 'production') {
  // Not fatal, because the alternative is a service that will not start, but
  // as loud as a log can be: this setting means anyone can inject a client
  // message for any salon.
  logger.error('WEBHOOK_ALLOW_UNSIGNED=true in production. Inbound webhooks accept unsigned payloads. Unset this.');
}

// A rejected promise nobody awaited used to end the process with nothing in
// Sentry: Node 22 treats it as fatal, Railway restarts the container, and the
// only trace was a gap in the uptime graph. The cron runner catches its own
// (lib/job-runs.js) and Express catches its handlers, so what reaches here is
// the genuinely unowned: a fire-and-forget push, a webhook side effect after
// the response was sent, a timer. Report it and carry on. uncaughtException is
// different: the process state is unknown after one, so it is reported and
// then the process exits as Node would have, but with the error on record.
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  logger.error({ err }, 'Unhandled promise rejection');
  try { Sentry.captureException(err, { tags: { origin: 'unhandledRejection' } }); } catch { /* Sentry itself must never take the process down */ }
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception, exiting');
  try { Sentry.captureException(err, { tags: { origin: 'uncaughtException' } }); } catch { /* as above */ }
  // Give Sentry a moment to flush, then exit as Node would have.
  Promise.resolve(Sentry.flush?.(2000)).catch(() => {}).finally(() => process.exit(1));
});

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

// ── Liveness: is this process running at all? ──────────────────────────────
// Railway restarts a container whose liveness probe fails. That MUST NOT be
// wired to the dependency checks below: if Supabase has a wobble, killing and
// restarting the API makes it worse, and a restart loop turns a five minute
// dependency blip into a full outage. This endpoint answers 200 as long as the
// event loop is turning, and nothing else.
app.get('/health/live', (req, res) => {
  res.json({ status: 'alive' });
});

// ── Readiness: is this service actually able to do its job? ────────────────
// This used to be res.json({ status: 'ok' }), a literal that returned ok while
// the Stripe webhook rejected every event for six weeks and while Instagram
// outbound was dead for five. BetterStack monitors this URL, so it has to be
// capable of going red. 200 = all critical checks passed, 503 = at least one
// critical dependency is down. Never throws: an unanswered health check tells
// a human nothing.
app.get('/health', async (req, res) => {
  try {
    // Pass the live registry rather than a hardcoded list, so the names
    // /health reports and the names that actually run cannot drift apart.
    const result = await runHealthChecks({ stripe: healthStripe, jobs: listJobs() });
    if (result.status === 'degraded') {
      reportDegraded(result);
      return res.status(503).json({
        status: 'degraded',
        failing: result.failing,
        warnings: result.warnings,
        checks: result.checks,
        service: result.service,
        checked_at: result.checked_at,
      });
    }
    return res.json(result);
  } catch (err) {
    // The check harness itself failing is a degraded service, not a 500 with
    // no information. Say what happened.
    logger.error({ err }, 'Health check harness failed');
    return res.status(503).json({ status: 'degraded', failing: ['health_check_harness'], error: err?.message || 'unknown' });
  }
});

// API routes
//
// `paywall` sits in front of the routers that are the beautician's own working
// surface: the diary, her clients, her money, her inbox, anything Florrie
// writes on her behalf. Once the 14-day trial is over and there is no active
// subscription, those return 403 and the app shows the upgrade screen.
//
// Everything else is left open ON PURPOSE, and the reasons matter:
//   /health                     uptime probes must answer even mid-outage
//   /api/auth                   she has to be able to sign in to fix her billing
//   /api/billing, /api/stripe   never put the pay button behind the paywall
//   /api/booking, /api/courses  the public booking pages. Her clients are not
//                               the subscriber and must never be locked out of
//                               a booking because the salon owes us GBP 29
//   /api/webhooks/*             inbound WhatsApp, SMS and Instagram. Dropping a
//                               real client's message is not a billing lever
//   /api/consultation-forms,    client-facing links sent out before expiry
//   /api/photo-consent
//   /api/calendar               the private iCal feed, authenticated by a URL
//                               token rather than a JWT
//   /api/push, /api/features,   read-only or account-level plumbing; blocking
//   /api/usage, /api/setup      them buys nothing and breaks the upgrade flow
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/treatments', apiLimiter, paywall, treatmentRoutes);
app.use('/api/clients', apiLimiter, paywall, clientRoutes);
app.use('/api/appointments', apiLimiter, paywall, appointmentRoutes);
app.use('/api/booking', bookingLimiter, bookingRoutes); // public booking page API
app.use('/api/ai-actions', apiLimiter, paywall, aiActionRoutes);
app.use('/api/activity', apiLimiter, activityRoutes);
app.use('/api/inbox', apiLimiter, paywall, inboxRoutes);
app.use('/api/webhooks', webhookLimiter, webhookRoutes); // WhatsApp + Twilio + Bird SMS inbound webhooks
app.use('/api/escalations', apiLimiter, paywall, escalationRoutes);
app.use('/api/content', apiLimiter, paywall, contentRoutes);
app.use('/api/money', apiLimiter, paywall, moneyRoutes);
app.use('/api/recurring-expenses', apiLimiter, paywall, recurringExpenseRoutes); // the rules behind regular costs, materialised daily by the recurring-expenses job
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
app.use('/api/products', apiLimiter, paywall, productRoutes);
app.use('/api/migrate', apiLimiter, migrateRoutes);
app.use('/api/import', apiLimiter, paywall, importAppointmentsRoutes); // Timely appointment CSV import
app.use('/api/usage', apiLimiter, usageRoutes);
app.use('/api/setup', apiLimiter, setupRoutes);
app.use('/api/whatsapp', apiLimiter, whatsappConfigRoutes);
app.use('/api/webhooks/instagram', webhookLimiter, instagramWebhookRoutes);
app.use('/api/webhooks/twilio', webhookLimiter, twilioWebhookRoutes); // Twilio BSP WhatsApp inbound
app.use('/api/coach', apiLimiter, paywall, coachRoutes);
app.use('/api/instagram', apiLimiter, instagramRoutes);
app.use('/api/courses', bookingLimiter, courseRoutes); // public course enrollment API
app.use('/api/suggestions', apiLimiter, suggestionsRoutes);
app.use('/api/florrie-thinks', apiLimiter, florrieThinksRoutes); // the rebuilt, grounded Florrie-thinks feed
app.use('/api/outbound', apiLimiter, paywall, outboundRoutes); // Florrie's outbox: review/approve proactive sends
app.use('/api/calendar', apiLimiter, calendarRoutes); // private iCal subscribe feed + sync URLs
app.use('/api/knowledge', apiLimiter, paywall, knowledgeRoutes); // the salon's own notes, what the AI front desk may quote

// Sentry error handler , must come after all routes, before the generic handler
if (process.env.SENTRY_DSN) {
  Sentry.setupExpressErrorHandler(app);
}

// Generic error handler
app.use((err, req, res, next) => {
  logger.error({ err }, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, async () => {
  logger.info({ port: PORT }, 'Florrie API started');

  // One scheduler, one ledger, one leader.
  //
  // Registration is declarative and lives in jobs/register.js. The scheduler
  // ticks every minute, asks job_runs which jobs have not SUCCEEDED within
  // their own cadence, claims each one with a compare-and-swap so a second
  // Railway replica cannot double-run it, and stamps the result. A daily job
  // therefore runs a day after its last success rather than a day after the
  // last deploy, which is the difference between running and not running at
  // all.
  const registered = registerAllJobs();
  startScheduler();
  logger.info({ jobs: registered }, 'Background jobs registered');

  // Ask once whether messages.authored_by exists. If the migration has not been
  // run (or PgBouncer has not seen it yet) every insert into messages would be
  // rejected whole for one unknown column, and Ellie's inbox would stop
  // recording. See lib/authorship.js.
  // Awaited: until this answers, authorship is off, and an insert that guesses
  // wrong fails the whole row. A few hundred milliseconds at boot is cheaper
  // than a blank inbox.
  await probeAuthorshipColumn();
});
