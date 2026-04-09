-- Migration 036: client_nudges table for comeback engine idempotency
-- Tracks which clients have been sent nudges recently to avoid duplicate messaging.

CREATE TABLE IF NOT EXISTS client_nudges (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  client_phone TEXT NOT NULL,
  nudge_type TEXT DEFAULT 'comeback',
  sent_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for efficient lookups during comeback engine run
CREATE INDEX IF NOT EXISTS idx_client_nudges_lookup
  ON client_nudges(beautician_id, client_phone, nudge_type, sent_at DESC);

-- RLS policies
ALTER TABLE client_nudges ENABLE ROW LEVEL SECURITY;

-- Beauticians can only see their own nudges
CREATE POLICY "beauticians_read_own_nudges" ON client_nudges
  FOR SELECT USING (beautician_id = auth.uid());

CREATE POLICY "service_insert_nudges" ON client_nudges
  FOR INSERT WITH CHECK (true);
