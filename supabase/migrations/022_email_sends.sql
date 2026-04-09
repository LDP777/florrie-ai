-- Email sends tracking table for sequence engine
-- Prevents double-sends, tracks delivery status, enables analytics.

CREATE TABLE IF NOT EXISTS email_sends (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  email_key TEXT NOT NULL,
  sequence TEXT NOT NULL,
  subject TEXT NOT NULL,
  send_at TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'pending', 'sent', 'failed', 'skipped')),
  context JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Dedup index: one email_key per beautician
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_sends_key
  ON email_sends (email_key);

-- Queue processing: find due emails quickly
CREATE INDEX IF NOT EXISTS idx_email_sends_queue
  ON email_sends (status, send_at)
  WHERE status IN ('scheduled', 'pending');

-- Per-beautician history
CREATE INDEX IF NOT EXISTS idx_email_sends_beautician
  ON email_sends (beautician_id, created_at DESC);

-- Add marketing_emails_enabled preference to beauticians
ALTER TABLE beauticians
  ADD COLUMN IF NOT EXISTS marketing_emails_enabled BOOLEAN DEFAULT true;

-- RLS
ALTER TABLE email_sends ENABLE ROW LEVEL SECURITY;

CREATE POLICY email_sends_own ON email_sends
  FOR ALL USING (beautician_id = auth.uid());

-- Updated_at trigger
CREATE OR REPLACE TRIGGER email_sends_updated_at
  BEFORE UPDATE ON email_sends
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();
