-- COMP_PILOT_ACCOUNT.sql
-- Run this in the Supabase SQL editor BEFORE deploying the trial paywall.
-- Written 2026-08-02. Nothing in here has been run for you.
--
-- WHY THIS IS URGENT
-- Until now the trial clock never started. The live signup path creates the
-- beauticians row from the browser and never wrote trial_ends_at, and the
-- column has no database default either: migration 001 created it plain, and
-- migration 019 tried to add the "now() + 14 days" default with
-- ADD COLUMN IF NOT EXISTS, which is a no-op once the column already exists.
-- So every account has trial_ends_at = NULL, and both the app and the API read
-- NULL as "there is no trial to expire".
--
-- The paywall fixes that by treating a NULL trial_ends_at as a trial that
-- started at created_at. That is correct for new signups and it is FATAL for
-- Ellie: her account was created in May 2026, so the derived trial ended in
-- May, and the moment the deploy lands she loses the diary, her clients, the
-- inbox, the money screens and Florrie's outbox. Her clients keep booking (the
-- public booking routes are never gated), but she cannot run her salon.
--
-- Put her on a comped plan first. Deploy second.

-- ---------------------------------------------------------------------------
-- STEP 1. Look before you touch. Confirm which row is Ellie and what state it
-- is in. Expect subscription_plan = 'trial', subscription_status = 'trial',
-- trial_ends_at = NULL.
-- ---------------------------------------------------------------------------
SELECT id,
       email,
       business_name,
       created_at,
       subscription_plan,
       subscription_status,
       trial_ends_at,
       stripe_customer_id
FROM beauticians
ORDER BY created_at;

-- ---------------------------------------------------------------------------
-- STEP 2. Comp the pilot account.
--
-- Replace the email with the exact address from STEP 1 before running.
-- requireActiveSubscription() lets a request through when
-- subscription_status = 'active' AND subscription_plan is 'florrie' or
-- 'florrie_team', so those two columns are what actually matter. The far
-- future trial_ends_at is belt and braces: if anything ever flips her status
-- back to 'trial', she still is not locked out on a Saturday morning.
--
-- Note she has no Stripe subscription, so this is a manual comp. If she later
-- pays through checkout, the billing webhook will overwrite these columns with
-- the real Stripe state, which is exactly what we want.
-- ---------------------------------------------------------------------------
UPDATE beauticians
SET subscription_plan   = 'florrie',
    subscription_status = 'active',
    trial_ends_at       = TIMESTAMPTZ '2030-01-01 00:00:00+00',
    updated_at          = now()
WHERE email = 'REPLACE_WITH_ELLIES_EMAIL'
RETURNING id, email, subscription_plan, subscription_status, trial_ends_at;

-- Expect exactly 1 row back. If you get 0, the email is wrong. If you get more
-- than 1, stop and check STEP 1 again.

-- ---------------------------------------------------------------------------
-- STEP 3 (optional, do this only if you want the honest dates on record).
--
-- Backfill every other account that has no trial_ends_at, so the value is
-- stored rather than derived on the fly. The backend derives the same window
-- anyway, so skipping this changes nothing about who can log in. It only makes
-- the table readable.
--
-- This will END the trial for anyone who signed up more than 14 days ago.
-- Run STEP 1 first and be sure you are happy with every name on that list.
-- ---------------------------------------------------------------------------
-- UPDATE beauticians
-- SET trial_ends_at = created_at + interval '14 days',
--     updated_at    = now()
-- WHERE trial_ends_at IS NULL
--   AND NOT (subscription_status = 'active'
--            AND subscription_plan IN ('florrie', 'florrie_team'));

-- ---------------------------------------------------------------------------
-- STEP 4. Give the column a real default so a future insert that forgets
-- trial_ends_at still starts the clock. Migration 019 meant to do this and
-- silently did not.
-- ---------------------------------------------------------------------------
ALTER TABLE beauticians
  ALTER COLUMN trial_ends_at SET DEFAULT (now() + interval '14 days');
