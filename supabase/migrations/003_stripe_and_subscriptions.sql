-- Migration 003: Stripe Connect + Subscription Plans
-- Adds Stripe account fields to beauticians, plans table, and subscription tracking.

-- ═══════════════════════════════════════════════
-- 1. Add Stripe fields to beauticians
-- ═══════════════════════════════════════════════
ALTER TABLE beauticians ADD COLUMN IF NOT EXISTS stripe_account_id TEXT;
ALTER TABLE beauticians ADD COLUMN IF NOT EXISTS stripe_onboarding_complete BOOLEAN DEFAULT FALSE;
ALTER TABLE beauticians ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT; -- for subscription billing
ALTER TABLE beauticians ADD COLUMN IF NOT EXISTS subscription_plan TEXT DEFAULT 'free'; -- free, starter, pro, team
ALTER TABLE beauticians ADD COLUMN IF NOT EXISTS subscription_stripe_id TEXT; -- Stripe subscription ID
ALTER TABLE beauticians ADD COLUMN IF NOT EXISTS subscription_current_period_end TIMESTAMPTZ;

-- Social links + extra profile fields (used by BusinessProfile wiring)
ALTER TABLE beauticians ADD COLUMN IF NOT EXISTS tagline TEXT;
ALTER TABLE beauticians ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE beauticians ADD COLUMN IF NOT EXISTS social_links JSONB DEFAULT '{}';

-- ═══════════════════════════════════════════════
-- 2. Plans table — defines subscription tiers
-- ═══════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  price_monthly_cents INTEGER NOT NULL,
  stripe_price_id TEXT, -- Stripe Price ID for checkout
  max_clients INTEGER, -- NULL = unlimited
  max_team_members INTEGER DEFAULT 1,
  features JSONB DEFAULT '[]',
  includes_ai BOOLEAN DEFAULT FALSE,
  includes_sms BOOLEAN DEFAULT FALSE,
  includes_whatsapp BOOLEAN DEFAULT FALSE,
  sort_order INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed the plans
INSERT INTO plans (id, name, price_monthly_cents, max_clients, max_team_members, features, includes_ai, includes_sms, includes_whatsapp, sort_order)
VALUES
  ('free', 'Free', 0, 5, 1, '["5 clients", "Basic calendar", "Manual bookings", "Public booking page"]', FALSE, FALSE, FALSE, 0),
  ('starter', 'Starter', 2900, 50, 1, '["50 clients", "Online booking", "SMS reminders", "Receipt scanning", "Basic reports"]', FALSE, TRUE, FALSE, 1),
  ('pro', 'Pro', 5900, NULL, 2, '["Unlimited clients", "AI Front Desk", "WhatsApp automation", "Campaign SMS", "Smart Schedule", "Content Autopilot", "Full analytics"]', TRUE, TRUE, TRUE, 2),
  ('team', 'Team', 8900, NULL, 10, '["Everything in Pro", "Multi-location", "Staff rota", "Team performance", "Priority support"]', TRUE, TRUE, TRUE, 3)
ON CONFLICT (id) DO NOTHING;

-- ═══════════════════════════════════════════════
-- 3. Stripe events log — idempotency + audit trail
-- ═══════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS stripe_events (
  id TEXT PRIMARY KEY, -- Stripe event ID (evt_xxx)
  type TEXT NOT NULL,
  beautician_id UUID REFERENCES beauticians(id),
  data JSONB,
  processed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stripe_events_beautician ON stripe_events(beautician_id);
CREATE INDEX IF NOT EXISTS idx_stripe_events_type ON stripe_events(type);

-- ═══════════════════════════════════════════════
-- 4. Add deposit tracking to appointments
-- ═══════════════════════════════════════════════
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS stripe_payment_intent_id TEXT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS deposit_amount_cents INTEGER DEFAULT 0;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS deposit_status TEXT DEFAULT 'none'; -- none, pending, paid, refunded

-- Index for Stripe lookups
CREATE INDEX IF NOT EXISTS idx_beauticians_stripe ON beauticians(stripe_account_id);
CREATE INDEX IF NOT EXISTS idx_appointments_stripe_pi ON appointments(stripe_payment_intent_id);
