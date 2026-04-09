-- SMS metering table for tracking weekly SMS usage and surplus costs
CREATE TABLE sms_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  week_start DATE NOT NULL,  -- Monday of the billing week (UTC)
  messages_sent INTEGER NOT NULL DEFAULT 0,
  free_limit INTEGER NOT NULL DEFAULT 50,
  surplus_count INTEGER NOT NULL DEFAULT 0,
  surplus_rate_pence INTEGER NOT NULL DEFAULT 2,  -- 2p per surplus text
  surplus_total_pence INTEGER NOT NULL DEFAULT 0,
  billed BOOLEAN NOT NULL DEFAULT false,
  stripe_invoice_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(beautician_id, week_start)
);

CREATE INDEX idx_sms_usage_beautician_week ON sms_usage(beautician_id, week_start);
CREATE INDEX idx_sms_usage_unbilled ON sms_usage(billed, surplus_total_pence) WHERE billed = false AND surplus_total_pence > 0;

-- RLS: beauticians can only see their own usage
ALTER TABLE sms_usage ENABLE ROW LEVEL SECURITY;
CREATE POLICY "beauticians_own_sms_usage" ON sms_usage
  FOR ALL USING (beautician_id = auth.uid());
