-- 058: named reward for the loyalty programme.
-- The Loyalty page lets the beautician name the one reward clients work
-- towards ("Free lash infill") alongside the threshold that already exists
-- from 007. reward_threshold is included defensively for environments where
-- 007 predates it.
ALTER TABLE loyalty_config ADD COLUMN IF NOT EXISTS reward_name TEXT;
ALTER TABLE loyalty_config ADD COLUMN IF NOT EXISTS reward_threshold INTEGER DEFAULT 100;
