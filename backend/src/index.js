import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import { createClient } from '@supabase/supabase-js';
import logger from './lib/logger.js';
import { apiLimiter, authLimiter, bookingLimiter } from './middleware/rate-limit.js';

// Services
import { processReminders } from './services/notifications.js';
import { cleanupStaleBookings } from './services/cleanup.js';

// Routes
import authRoutes from './routes/auth.js';
import treatmentRoutes from './routes/treatments.js';
import clientRoutes from './routes/clients.js';
import appointmentRoutes from './routes/appointments.js';
import bookingRoutes from './routes/booking.js';
import aiActionRoutes from './routes/ai-actions.js';
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

dotenv.config();

// ── Startup validation ──────────────────────────────
const REQUIRED_ENV = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_KEY',
  'FRONTEND_URL',
  'STRIPE_WEBHOOK_SECRET',
];
const OPTIONAL_ENV = [
  'STRIPE_SECRET_KEY',
  'RESEND_API_KEY',
  'ANTHROPIC_API_KEY',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'ENCRYPTION_KEY',
];

const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  logger.fatal({ missing }, 'Missing required env vars');
  process.exit(1);
}

const unset = OPTIONAL_ENV.filter(k => !process.env[k]);
if (unset.length) {
  logger.warn({ unset }, 'Optional env vars not set — some features disabled');
}

const app = express();
const PORT = process.env.PORT || 3001;

// Railway / Render / Fly all run behind a reverse proxy
app.set('trust proxy', 1);

// Supabase client (service role for backend operations)
export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Supabase client (anon key for auth-gated operations)
export const supabaseAnon = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Middleware
app.use(cors({ origin: process.env.FRONTEND_URL }));

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

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

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
app.use('/api/webhooks', webhookLimiter, webhookRoutes); // WhatsApp + Stripe webhooks
app.use('/api/escalations', apiLimiter, escalationRoutes);
app.use('/api/content', apiLimiter, contentRoutes);
app.use('/api/money', apiLimiter, moneyRoutes);
app.use('/api/stripe', apiLimiter, stripeRoutes);
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

// Error handler
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

  // Also run once on startup (catches any missed during deploys)
  processReminders().then(r => {
    if (r?.sent > 0) logger.info({ sent: r.sent }, 'Startup: sent reminders');
  }).catch(() => {});

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
});
