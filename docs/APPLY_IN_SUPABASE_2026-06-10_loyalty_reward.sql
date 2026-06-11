-- Paste into the Supabase SQL editor (florrie prod), 2026-06-10.
-- Adds the named reward column the rebuilt Loyalty page saves to.
-- Mirrors supabase/migrations/058_loyalty_reward.sql. Safe to run twice.

ALTER TABLE loyalty_config ADD COLUMN IF NOT EXISTS reward_name TEXT;
ALTER TABLE loyalty_config ADD COLUMN IF NOT EXISTS reward_threshold INTEGER DEFAULT 100;
