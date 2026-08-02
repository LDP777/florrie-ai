-- 020: job_runs, the table that knows whether the crons are still alive.
--
-- Every background job in this backend is a setInterval inside app.listen.
-- If one starts throwing, or stops being scheduled, or the container restarts
-- every few hours so a 24h interval never matures, nothing anywhere records
-- that it stopped running. The Instagram token died on 21 June and outbound
-- Instagram was dead for five weeks while the app still said "Connected".
-- The Stripe webhook rejected every event for six weeks. In both cases the
-- system had no notion of "this thing last worked at".
--
-- One row per job. recordJobRun() in lib/job-runs.js stamps it; /health reads
-- it and reports any job whose last success is older than it should be.
--
-- Run by hand in the Supabase SQL editor (idempotent, safe to re-run).
-- After running, RESTART Railway (not redeploy) so PgBouncer's schema cache
-- picks up the new table. Until then lib/job-runs.js and /health both degrade
-- quietly rather than erroring, so applying this is not urgent.

CREATE TABLE IF NOT EXISTS job_runs (
  job_name TEXT PRIMARY KEY,
  last_started_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0
);

COMMENT ON TABLE job_runs IS 'Heartbeat per background job. Read by GET /health to detect a cron that has silently stopped.';
COMMENT ON COLUMN job_runs.last_started_at IS 'Set every time the job begins. last_started_at newer than last_success_at by a long way means it is hanging or crashing mid-run.';
COMMENT ON COLUMN job_runs.last_success_at IS 'Set only when the job function returns without throwing.';
COMMENT ON COLUMN job_runs.last_error IS 'Message from the most recent failure, truncated. Cleared on the next success.';
COMMENT ON COLUMN job_runs.consecutive_failures IS 'Reset to 0 on success. Rising counts are the signal worth alerting on.';
