-- WhatsApp number registration fields on beauticians
-- whatsapp_phone_id and whatsapp_token already exist (001_initial_schema.sql)
-- whatsapp_connected and whatsapp_phone already exist (007_all_features.sql)
ALTER TABLE beauticians
  ADD COLUMN IF NOT EXISTS whatsapp_display_name TEXT,
  ADD COLUMN IF NOT EXISTS whatsapp_registered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS whatsapp_pending_phone TEXT; -- number awaiting OTP verification

-- Monthly combined message usage (SMS + WhatsApp, 120/month limit per tiers.js)
-- Replaces the weekly sms_usage model for new quota enforcement.
-- sms_usage kept for backward compat / historical data.
CREATE TABLE IF NOT EXISTS message_usage (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  beautician_id         UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  month                 DATE NOT NULL, -- first day of the month (UTC), e.g. 2026-04-01
  sms_sent              INTEGER NOT NULL DEFAULT 0,
  whatsapp_sent         INTEGER NOT NULL DEFAULT 0,
  free_limit            INTEGER NOT NULL DEFAULT 120,
  overage_sms_count     INTEGER NOT NULL DEFAULT 0,
  overage_wa_count      INTEGER NOT NULL DEFAULT 0,
  overage_sms_pence     INTEGER NOT NULL DEFAULT 0,  -- 6p per surplus SMS
  overage_wa_pence      INTEGER NOT NULL DEFAULT 0,  -- 5p per surplus WA conversation
  overage_total_pence   INTEGER NOT NULL DEFAULT 0,
  billed                BOOLEAN NOT NULL DEFAULT false,
  stripe_invoice_id     TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(beautician_id, month)
);

CREATE INDEX IF NOT EXISTS idx_message_usage_beautician_month
  ON message_usage(beautician_id, month);

CREATE INDEX IF NOT EXISTS idx_message_usage_unbilled
  ON message_usage(billed, overage_total_pence)
  WHERE billed = false AND overage_total_pence > 0;

-- RLS: beauticians see only their own usage
ALTER TABLE message_usage ENABLE ROW LEVEL SECURITY;
CREATE POLICY "beauticians_own_message_usage" ON message_usage
  FOR ALL USING (beautician_id = auth.uid());
