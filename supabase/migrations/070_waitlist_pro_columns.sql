-- 070_waitlist_pro_columns.sql
-- Reconcile the canonical `waitlist` table (defined in 001_initial_schema.sql)
-- with the columns the live code and the WaitlistPro page actually use.
--
-- Canonical table = `waitlist` (client/treatment slot waitlist). This is the one
-- the gap-fill engine, booking reschedule notifier, the /api/features/waitlist
-- routes, and the AutomationRules "waitlist_match" trigger all read and write.
-- The other two tables (`waitlist` from backend/src/migrations/011_waitlist.sql
-- and `waitlist_signups`) are landing-page email capture lists and are unrelated.
--
-- This migration is additive and idempotent. Apply once in the Supabase SQL editor.

-- 1. Columns the WaitlistPro page and engines reference but 001 never created.
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS priority TEXT DEFAULT 'regular';
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS notify_count INTEGER DEFAULT 0;
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ;
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS last_notified_at TIMESTAMPTZ;
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS deposit_held BOOLEAN DEFAULT false;
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS deposit_amount_cents INTEGER DEFAULT 0;
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS max_wait_days INTEGER DEFAULT 14;
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS preferred_time TEXT DEFAULT 'any';
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS offer_expires_at TIMESTAMPTZ;

-- 2. The gap-fill engine and booking notifier query status IN ('active','waiting')
--    and set status 'notified'. The original CHECK only allowed
--    ('waiting','offered','booked','expired'), so those writes would fail.
--    Widen the allowed set so the live code stops erroring. Keep 'waiting' the
--    default so the engine's .eq('status','waiting') lookups keep working.
ALTER TABLE waitlist DROP CONSTRAINT IF EXISTS waitlist_status_check;
ALTER TABLE waitlist ADD CONSTRAINT waitlist_status_check
  CHECK (status IN ('waiting', 'active', 'notified', 'offered', 'booked', 'expired'));

-- 3. Priority constraint mirrors the page's three tiers.
ALTER TABLE waitlist DROP CONSTRAINT IF EXISTS waitlist_priority_check;
ALTER TABLE waitlist ADD CONSTRAINT waitlist_priority_check
  CHECK (priority IN ('vip', 'regular', 'flexible'));

-- 4. Index the active set the way the engines read it (status + notified_at null).
CREATE INDEX IF NOT EXISTS idx_waitlist_active_unnotified
  ON waitlist (beautician_id, status)
  WHERE notified_at IS NULL;
