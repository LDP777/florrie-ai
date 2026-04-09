-- HMRC MTD integration — beautician OAuth tokens + submission history.

-- Add HMRC fields to beauticians
ALTER TABLE beauticians
  ADD COLUMN IF NOT EXISTS hmrc_nino TEXT,
  ADD COLUMN IF NOT EXISTS hmrc_access_token TEXT,
  ADD COLUMN IF NOT EXISTS hmrc_refresh_token TEXT,
  ADD COLUMN IF NOT EXISTS hmrc_token_expires_at TIMESTAMPTZ;

-- Submission tracking table
CREATE TABLE IF NOT EXISTS hmrc_submissions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  tax_year TEXT NOT NULL,        -- e.g. '2025-26'
  quarter TEXT NOT NULL,         -- 'Q1', 'Q2', 'Q3', 'Q4'
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  payload JSONB NOT NULL,        -- what we sent to HMRC
  response JSONB,                -- what HMRC returned
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'submitted', 'failed', 'accepted', 'rejected')),
  hmrc_status_code INTEGER,
  submitted_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Index for querying submissions per beautician per tax year
CREATE INDEX IF NOT EXISTS idx_hmrc_submissions_beautician
  ON hmrc_submissions (beautician_id, tax_year, quarter);

-- RLS
ALTER TABLE hmrc_submissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY hmrc_submissions_own ON hmrc_submissions
  FOR ALL USING (beautician_id = auth.uid());

-- Updated_at trigger
CREATE TRIGGER set_hmrc_submissions_updated_at
  BEFORE UPDATE ON hmrc_submissions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
