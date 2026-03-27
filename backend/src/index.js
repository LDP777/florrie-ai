import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

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

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

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
app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:5173' }));

// Raw body for Stripe webhook signature verification
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }), (req, res, next) => {
  req.rawBody = req.body;
  next();
});

app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'florrie-api', version: '0.1.0' });
});

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/treatments', treatmentRoutes);
app.use('/api/clients', clientRoutes);
app.use('/api/appointments', appointmentRoutes);
app.use('/api/booking', bookingRoutes); // public booking page API
app.use('/api/ai-actions', aiActionRoutes);
app.use('/api/webhooks', webhookRoutes); // WhatsApp + Stripe webhooks
app.use('/api/escalations', escalationRoutes);
app.use('/api/content', contentRoutes);
app.use('/api/money', moneyRoutes);
app.use('/api/stripe', stripeRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/gcal', gcalRoutes);

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Florrie API running on port ${PORT}`);
});
