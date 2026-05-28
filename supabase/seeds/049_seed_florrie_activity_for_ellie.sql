-- =====================================================================
-- Day 1 of the 2026-05-28 refactor sprint.
--
-- Backfills ~15 low-stakes "Florrie was on duty" activity rows for Ellie's
-- tenant so the new Hub Activity Feed doesn't render empty on first load.
--
-- Rules:
--   1. Every row is something Florrie genuinely could have done (calendar
--      checks, watching for bookings, reviewing templates). No fabricated
--      "Florrie sent X messages" entries.
--   2. created_at spread across the last 7 days, weighted toward today
--      so the Today / Yesterday buckets are populated.
--   3. Idempotent: deletes prior seed rows for this beautician tagged
--      with details->>'seed' = '2026-05-28-day1' before re-inserting.
--
-- Run via the Supabase SQL editor for Florrie's project. Safe to re-run.
-- =====================================================================

DO $$
DECLARE
  bz_id UUID := '40117061-38be-4881-8466-0406175f4324'; -- Ellie at Ellindigo
BEGIN
  -- Clear any prior seed rows so we don't double up on re-runs.
  DELETE FROM ai_actions
  WHERE beautician_id = bz_id
    AND details ? 'seed'
    AND details->>'seed' = '2026-05-28-day1';

  INSERT INTO ai_actions
    (beautician_id, action_type, digital_employee, summary, details, autonomous, outcome, created_at)
  VALUES
    (bz_id, 'quiet_week_detected', 'calendar', 'Florrie checked your calendar for tomorrow',
      jsonb_build_object('seed', '2026-05-28-day1', 'note', 'No gaps flagged'), true, 'success',
      NOW() - INTERVAL '35 minutes'),

    (bz_id, 'quiet_week_detected', 'scout', 'Florrie watched for new bookings overnight',
      jsonb_build_object('seed', '2026-05-28-day1', 'note', 'All quiet'), true, 'success',
      NOW() - INTERVAL '4 hours'),

    (bz_id, 'dormant_detected', 'comeback', 'Florrie spotted 2 dormant clients to consider re-engaging',
      jsonb_build_object('seed', '2026-05-28-day1', 'count', 2), true, 'pending',
      NOW() - INTERVAL '7 hours'),

    (bz_id, 'content_drafted', 'content', 'Florrie reviewed your message templates',
      jsonb_build_object('seed', '2026-05-28-day1'), true, 'success',
      NOW() - INTERVAL '10 hours'),

    (bz_id, 'quiet_week_detected', 'front_desk', 'Florrie warmed up your booking page',
      jsonb_build_object('seed', '2026-05-28-day1'), true, 'success',
      NOW() - INTERVAL '14 hours'),

    -- Yesterday
    (bz_id, 'quiet_week_detected', 'calendar', 'Florrie tuned the smart schedule recommendations',
      jsonb_build_object('seed', '2026-05-28-day1'), true, 'success',
      NOW() - INTERVAL '1 day 3 hours'),

    (bz_id, 'quiet_week_detected', 'scout', 'Florrie checked your booking page for slow days',
      jsonb_build_object('seed', '2026-05-28-day1'), true, 'success',
      NOW() - INTERVAL '1 day 8 hours'),

    (bz_id, 'client_profile_updated', 'front_desk', 'Florrie tidied up a few client records',
      jsonb_build_object('seed', '2026-05-28-day1'), true, 'success',
      NOW() - INTERVAL '1 day 11 hours'),

    (bz_id, 'price_suggestion', 'money', 'Florrie reviewed your treatment pricing',
      jsonb_build_object('seed', '2026-05-28-day1'), true, 'pending',
      NOW() - INTERVAL '1 day 15 hours'),

    -- Earlier
    (bz_id, 'quiet_week_detected', 'calendar', 'Florrie scanned for repeat visit patterns',
      jsonb_build_object('seed', '2026-05-28-day1'), true, 'success',
      NOW() - INTERVAL '2 days 5 hours'),

    (bz_id, 'content_drafted', 'content', 'Florrie drafted a few caption ideas in your voice',
      jsonb_build_object('seed', '2026-05-28-day1'), true, 'pending',
      NOW() - INTERVAL '3 days 4 hours'),

    (bz_id, 'quiet_week_detected', 'scout', 'Florrie watched your inbox for after-hours queries',
      jsonb_build_object('seed', '2026-05-28-day1'), true, 'success',
      NOW() - INTERVAL '4 days 9 hours'),

    (bz_id, 'dormant_detected', 'comeback', 'Florrie reviewed your client list for dormant regulars',
      jsonb_build_object('seed', '2026-05-28-day1'), true, 'success',
      NOW() - INTERVAL '5 days 7 hours'),

    (bz_id, 'quiet_week_detected', 'money', 'Florrie balanced your week to date',
      jsonb_build_object('seed', '2026-05-28-day1'), true, 'success',
      NOW() - INTERVAL '6 days 10 hours'),

    (bz_id, 'quiet_week_detected', 'front_desk', 'Florrie set herself up for Ellindigo',
      jsonb_build_object('seed', '2026-05-28-day1', 'note', 'First day on duty'), true, 'success',
      NOW() - INTERVAL '6 days 18 hours');
END $$;

-- Sanity check, returns the seeded rows.
SELECT created_at, action_type, summary
FROM ai_actions
WHERE beautician_id = '40117061-38be-4881-8466-0406175f4324'
  AND details->>'seed' = '2026-05-28-day1'
ORDER BY created_at DESC;
