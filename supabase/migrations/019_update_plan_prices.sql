-- Migration 019: Update plan prices to Apr 2026 pricing
-- Free £0, Starter £19/mo, Pro £39/mo, Team £69/mo
-- Also adds subscription_status and trial_ends_at to beauticians

UPDATE plans SET price_monthly_cents = 0 WHERE id = 'free';
UPDATE plans SET price_monthly_cents = 1900 WHERE id = 'starter';
UPDATE plans SET price_monthly_cents = 3900 WHERE id = 'pro';
UPDATE plans SET price_monthly_cents = 6900 WHERE id = 'team';

-- Add AI chat tracking
ALTER TABLE beauticians ADD COLUMN IF NOT EXISTS ai_chats_this_month INTEGER DEFAULT 0;
ALTER TABLE beauticians ADD COLUMN IF NOT EXISTS ai_chats_reset_at TIMESTAMPTZ DEFAULT now();

-- Add subscription status + trial tracking
ALTER TABLE beauticians ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'trial'; -- trial, active, past_due, cancelled
ALTER TABLE beauticians ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ DEFAULT (now() + interval '14 days');
