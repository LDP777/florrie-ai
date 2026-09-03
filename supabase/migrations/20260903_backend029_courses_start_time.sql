-- 029: courses.start_time
--
-- 3 September 2026. Ellie built her first course in the app: a full day, a
-- date, a price, a deposit. Nowhere to say what time it starts, so the
-- student's confirmation could not either, and the calendar file that goes
-- with it had to guess. A time-of-day column, optional, London wall clock.
--
-- Every reader probes for the column (backend/src/lib/schema-probe.js) and
-- the Courses page retries a save without it if the database rejects it, so
-- nothing depends on this having run. Idempotent, no transaction, applied by
-- hand.

ALTER TABLE courses ADD COLUMN IF NOT EXISTS start_time time;
