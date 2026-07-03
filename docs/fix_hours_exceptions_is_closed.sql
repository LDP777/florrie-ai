-- Fix: partial-day time blocks stored with is_closed = true
--
-- The hours_exceptions table has a legacy is_closed column that DEFAULTS TO
-- TRUE (migration 007). The POST /api/hours-exceptions route never set it,
-- so every 'amended' time-range block (e.g. "block out 1 hour") was stored
-- with is_closed = true and the calendar rendered it as a full-day closure.
-- The API now sets is_closed explicitly; this backfills the existing rows.
--
-- Idempotent: safe to run more than once.

-- Preview the rows that will change:
SELECT id, beautician_id, date, type, start_time, end_time, is_closed
FROM hours_exceptions
WHERE type IN ('amended', 'extended')
  AND start_time IS NOT NULL
  AND end_time IS NOT NULL
  AND is_closed = true;

-- Apply:
UPDATE hours_exceptions
SET is_closed = false
WHERE type IN ('amended', 'extended')
  AND start_time IS NOT NULL
  AND end_time IS NOT NULL
  AND is_closed = true;
