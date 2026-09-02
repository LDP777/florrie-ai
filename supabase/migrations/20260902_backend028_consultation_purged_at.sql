-- 028: consultation_responses.purged_at
--
-- 2 September 2026. consultation_responses.expires_at was declared in
-- 20260409_backend009 as "auto-expire after 7 days" and nothing ever acted on
-- it. The answers are special-category health data (allergies, medication,
-- pregnancy, past reactions), so backend/src/jobs/consultation-purge.js now
-- nulls answers and signature_data on rows whose link expired unanswered.
--
-- purged_at records that the sweep ran on a row, so the job can skip rows it
-- has already cleared and so a "why is this form blank" question has an
-- answer. The job probes for the column and works without it; this file only
-- makes the marker available. Idempotent, no transaction, applied by hand.

ALTER TABLE consultation_responses ADD COLUMN IF NOT EXISTS purged_at timestamptz;

-- The sweep reads "expired and not yet purged" once a day; without this it is
-- a scan of every response the platform has ever raised.
CREATE INDEX IF NOT EXISTS idx_consultation_responses_purge
  ON consultation_responses (expires_at)
  WHERE purged_at IS NULL AND status <> 'completed';
