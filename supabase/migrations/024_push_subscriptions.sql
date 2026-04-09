-- Push notification subscriptions.
-- Each beautician can have multiple subscriptions (phone + laptop + tablet).

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  subscription JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- One subscription per endpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_push_endpoint
  ON push_subscriptions (endpoint);

-- Find all subs for a beautician
CREATE INDEX IF NOT EXISTS idx_push_beautician
  ON push_subscriptions (beautician_id);

-- RLS
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY push_subs_own ON push_subscriptions
  FOR ALL USING (beautician_id = auth.uid());
