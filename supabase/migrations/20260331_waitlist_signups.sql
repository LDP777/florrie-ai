-- Waitlist signups table for landing page signups
CREATE TABLE IF NOT EXISTS waitlist_signups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  source TEXT DEFAULT 'landing_page',
  signed_up_at TIMESTAMPTZ DEFAULT now(),
  notified BOOLEAN DEFAULT false
);

-- Index on email for fast lookups and upserts
CREATE INDEX IF NOT EXISTS idx_waitlist_email ON waitlist_signups(email);

-- Index on signed_up_at for ordering/pagination
CREATE INDEX IF NOT EXISTS idx_waitlist_signed_up_at ON waitlist_signups(signed_up_at DESC);

-- Enable RLS
ALTER TABLE waitlist_signups ENABLE ROW LEVEL SECURITY;

-- RLS Policies
-- Service role can do everything
CREATE POLICY "service_role_all"
  ON waitlist_signups
  FOR ALL
  USING (auth.role() = 'service_role');

-- Anonymous users can insert their own signup
CREATE POLICY "anon_can_insert"
  ON waitlist_signups
  FOR INSERT
  WITH CHECK (auth.role() = 'anon' OR auth.role() IS NULL);
