-- Migration: Update subscription plan tiers from old model to new model
-- Old: free, starter, pro, team
-- New: trial, florrie, florrie_team
--
-- Commercial model (Apr 2026):
--   trial        — 14 days, full access, no card
--   florrie      — £29/mo (annual £290/yr)
--   florrie_team — £29/mo base + £15/seat

-- Update column default
ALTER TABLE beauticians ALTER COLUMN subscription_plan SET DEFAULT 'trial';

-- Migrate existing users on old plan names
UPDATE beauticians SET subscription_plan = 'trial' WHERE subscription_plan = 'free';
UPDATE beauticians SET subscription_plan = 'florrie' WHERE subscription_plan IN ('starter', 'pro');
UPDATE beauticians SET subscription_plan = 'florrie_team' WHERE subscription_plan = 'team';

-- Update the plans table if it exists (seed data)
DELETE FROM plans WHERE id IN ('free', 'starter', 'pro', 'team');

INSERT INTO plans (id, name, price_monthly_cents, price_annual_cents, features)
VALUES
  ('trial', '14-day free trial', 0, 0, '["Full access for 14 days","Unlimited clients","AI receptionist","WhatsApp & SMS","Tax dashboard","Smart scheduling","Content autopilot","120 messages/month"]'),
  ('florrie', 'Florrie', 2900, 29000, '["Unlimited clients","AI receptionist","WhatsApp & SMS automation","Smart scheduling","Tax dashboard & HMRC tracking","Content autopilot","Compliance & patch test tracking","Analytics & reports","Receipt scanning","120 messages/month included"]'),
  ('florrie_team', 'Florrie for Teams', 2900, 29000, '["Everything in Florrie","Multi-location support","Staff rota & scheduling","Team performance tracking","Up to 10 team members","+£15/month per extra seat","120 messages/month per seat","Priority support"]')
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  price_monthly_cents = EXCLUDED.price_monthly_cents,
  price_annual_cents = EXCLUDED.price_annual_cents,
  features = EXCLUDED.features;
