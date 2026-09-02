-- 027: subscription_status vocabulary, and a marker for when the card failed.
--
-- 2 September 2026. beauticians.subscription_status carries a CHECK from
-- migration 001 that allows exactly 'trial', 'active', 'past_due' and
-- 'cancelled'. Both Stripe webhooks wrote Stripe's own status word into it:
-- 'canceled' (one L), 'unpaid', 'incomplete', 'incomplete_expired', 'paused'.
-- Every one of those violates the CHECK. PostgREST reports a violated CHECK
-- by resolving with { data: null, error }, not by throwing, and neither
-- webhook read the error. So when Stripe finished retrying a dead card and
-- moved the subscription to 'unpaid' or 'canceled', the UPDATE failed, the
-- row stayed 'active', and the salon kept the whole product for free with
-- nothing anywhere saying so.
--
-- THE CODE NO LONGER NEEDS THIS FILE TO BE CORRECT. Every write of
-- subscription_status that starts from a Stripe status now goes through
-- internalStatusFor in backend/src/lib/subscription-status.js, which only
-- ever answers 'active', 'past_due' or 'cancelled', and every one of those
-- writes reads its error and reports it. The wider CHECK below is a safety
-- net for a future writer that forgets the mapping: their write lands and
-- is visible in the data instead of vanishing. The constraint must never
-- again be the thing that decides who pays. That decision is made in code,
-- where it can log, alert and be tested.
--
-- Run by hand in the Supabase SQL editor (idempotent, safe to re-run).
-- After running, RESTART Railway so PgBouncer's schema cache sees the
-- new column.

-- 1. Widen the CHECK. The constraint name from 001 is whatever Postgres
--    generated (beauticians_subscription_status_check), and a file pasted
--    into a SQL editor by hand should not bet on it, so the existing CHECK
--    on the column is found by definition and replaced. Re-running this
--    drops the constraint added below and puts back an identical one.
DO $$
DECLARE
  existing record;
BEGIN
  FOR existing IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.beauticians'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%subscription_status%'
  LOOP
    EXECUTE format('ALTER TABLE beauticians DROP CONSTRAINT %I', existing.conname);
  END LOOP;

  ALTER TABLE beauticians
    ADD CONSTRAINT beauticians_subscription_status_check
    CHECK (subscription_status IN (
      -- Florrie's own four words. The code writes only these.
      'trial', 'active', 'past_due', 'cancelled',
      -- Stripe's raw words, accepted so an unmapped write is visible rather
      -- than silently dropped. Anything below here in the data is a bug in a
      -- writer that skipped lib/subscription-status.js.
      'trialing', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused'
    ));
END $$;

-- 2. When the salon's own Florrie payment last failed. Stamped by
--    services/dunning.js on invoice.payment_failed, cleared on invoice.paid.
--    middleware/require-plan.js measures the 7 day grace period from it. The
--    code probes for this column and works without it (past_due is allowed
--    through unconditionally, with a warning, until it exists).
ALTER TABLE beauticians ADD COLUMN IF NOT EXISTS payment_failed_at TIMESTAMPTZ;

COMMENT ON COLUMN beauticians.subscription_status IS
  'Florrie''s own vocabulary: trial, active, past_due, cancelled. Written only through internalStatusFor in backend/src/lib/subscription-status.js. The CHECK also accepts Stripe''s raw words (trialing, canceled, unpaid, incomplete, incomplete_expired, paused) purely so an unmapped write is visible in the data instead of failing silently; a row holding one of those is a bug in the writer. Widened 2 Sep 2026 after dead subscriptions sat at active for months because the narrower CHECK rejected the write and nobody read the error.';

COMMENT ON COLUMN beauticians.payment_failed_at IS
  'When the salon''s own subscription invoice last failed to pay. Set by services/dunning.js on invoice.payment_failed, cleared to NULL on invoice.paid. middleware/require-plan.js allows past_due through for 7 days from this timestamp and blocks after. NULL with status past_due means no failure has been recorded, and the grace period has not started.';
