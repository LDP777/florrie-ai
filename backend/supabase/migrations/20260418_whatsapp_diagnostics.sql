-- WhatsApp registration diagnostics log.
-- One row per failed /register attempt, capturing Meta's full response so we
-- can diagnose issues definitively instead of showing users a generic message.

CREATE TABLE IF NOT EXISTS whatsapp_diagnostics (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  beautician_id   UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  phone           TEXT NOT NULL,
  stage           TEXT NOT NULL,
  success         BOOLEAN NOT NULL DEFAULT false,
  meta_code       INTEGER,
  meta_subcode    INTEGER,
  meta_type       TEXT,
  meta_user_msg   TEXT,
  meta_user_title TEXT,
  meta_message    TEXT,
  fbtrace_id      TEXT,
  raw_response    JSONB,
  diagnosis       TEXT,
  suggested_action TEXT,
  retry_after     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wa_diag_beautician ON whatsapp_diagnostics(beautician_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wa_diag_phone ON whatsapp_diagnostics(phone);

COMMENT ON TABLE whatsapp_diagnostics IS 'Per-attempt log of WhatsApp registration calls to Meta. Used to diagnose connection failures.';
COMMENT ON COLUMN whatsapp_diagnostics.stage IS 'add_number | request_otp | verify_code | register_cloud_api';
COMMENT ON COLUMN whatsapp_diagnostics.diagnosis IS 'Our interpretation of the Meta error: on_consumer_whatsapp | on_other_waba | cooldown_active | verified_name_collision | invalid_number | rate_limit | waba_not_approved | unknown';
COMMENT ON COLUMN whatsapp_diagnostics.suggested_action IS 'wait | delete_account | contact_bsp | contact_meta | retry_now | contact_support';
