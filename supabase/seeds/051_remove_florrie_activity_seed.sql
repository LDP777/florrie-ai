-- =====================================================================
-- 2026-05-28 — Remove the Day 1 synthetic activity-feed seed.
--
-- Day 1 of the refactor sprint backfilled ~15 "Florrie was on duty" rows
-- in supabase/seeds/049_seed_florrie_activity_for_ellie.sql so the new
-- Hub feed wouldn't render empty for Ellie. Those rows were tagged with
-- details->>'seed' = '2026-05-28-day1' for exactly this kind of cleanup.
--
-- The replacement is the florrie-heartbeat service (deployed in the same
-- ship): once a day per beautician it runs five real checks and logs the
-- actual numbers (tomorrow's bookings, dormant client count, overnight
-- bookings, client list totals, unread inbox count) to ai_actions. Those
-- rows are tagged details->>'heartbeat' = 'true'.
--
-- Run via the Supabase SQL editor for Florrie's project once the heartbeat
-- service has run at least once (check Railway logs for "Heartbeat: daily
-- run complete"). Safe to re-run.
-- =====================================================================

BEGIN;

-- Show what we're about to remove
SELECT
  beautician_id,
  COUNT(*) AS seed_rows
FROM ai_actions
WHERE details->>'seed' = '2026-05-28-day1'
GROUP BY beautician_id;

-- Delete the synthetic rows. Real heartbeat rows are not tagged with 'seed',
-- so they survive.
DELETE FROM ai_actions
WHERE details->>'seed' = '2026-05-28-day1';

-- Confirm: count real heartbeat rows that took their place
SELECT
  beautician_id,
  COUNT(*) AS heartbeat_rows,
  MAX(created_at) AS most_recent
FROM ai_actions
WHERE (details->>'heartbeat')::boolean = true
GROUP BY beautician_id;

COMMIT;
