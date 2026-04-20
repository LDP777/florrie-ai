-- 045_whatsapp_schema_fix.sql
--
-- Migration 028's comment claimed whatsapp_phone + whatsapp_connected already
-- existed from 007_all_features.sql, but they never actually got added. The
-- retry worker ships its first query against `beauticians.whatsapp_phone` the
-- moment the backend boots with a live WABA and Postgres throws 42703.
--
-- This migration is the idempotent fix for that + the rest of the WhatsApp
-- runtime state the code reads from and writes to, plus the diagnostics sink
-- the preflight / request_otp / verify / reset stages try to insert into.

-- ─────────────────────────────────────────────────────────────────────────
-- Beauticians: WhatsApp runtime state the code expects to exist
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE beauticians
  -- Verified E.164 phone (distinct from whatsapp_pending_phone which is
  -- the number parked while awaiting OTP). Set on successful /verify.
  ADD COLUMN IF NOT EXISTS whatsapp_phone              TEXT,

  -- True once the Cloud API number is ACTIVE on Meta (not just OTP-verified).
  ADD COLUMN IF NOT EXISTS whatsapp_connected          BOOLEAN NOT NULL DEFAULT false,

  -- /verify succeeded at HTTP layer but Meta's phone_numbers status is still
  -- PENDING. Retry worker polls these every 5m, flips connected=true when
  -- Meta reports ACTIVE.
  ADD COLUMN IF NOT EXISTS whatsapp_pending_activation BOOLEAN NOT NULL DEFAULT false,

  -- ISO timestamp telling the retry worker when to pick this row up again.
  ADD COLUMN IF NOT EXISTS whatsapp_retry_at           TIMESTAMPTZ,

  -- cooldown_active | rate_limit | pending_activation | otp_retry_pending
  ADD COLUMN IF NOT EXISTS whatsapp_retry_reason       TEXT,

  -- Caps retries at 8 attempts before marking retry_exhausted.
  ADD COLUMN IF NOT EXISTS whatsapp_retry_attempts     INTEGER NOT NULL DEFAULT 0,

  -- Sticky flag. Tells the frontend to show the "contact support" banner
  -- after all retry budget is burnt.
  ADD COLUMN IF NOT EXISTS whatsapp_retry_exhausted    BOOLEAN NOT NULL DEFAULT false;

-- Retry worker scans for due rows every 5m; index the common lookup.
CREATE INDEX IF NOT EXISTS idx_beauticians_whatsapp_retry_at
  ON beauticians(whatsapp_retry_at)
  WHERE whatsapp_retry_at IS NOT NULL;

-- whatsapp_phone_id is looked up in webhooks.js on every inbound message.
-- Make sure it's covered.
CREATE INDEX IF NOT EXISTS idx_beauticians_whatsapp_phone_id
  ON beauticians(whatsapp_phone_id)
  WHERE whatsapp_phone_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- whatsapp_diagnostics: audit trail written by logDiagnostic() at every
-- stage of the connect flow. Missing table = every write swallowed by the
-- try/catch in logDiagnostic — no audit trail, silent debugging hell.
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS whatsapp_diagnostics (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  beautician_id    UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  phone            TEXT,

  -- preflight | add_number | request_otp | verify | reset | retry_worker | activation_poll
  stage            TEXT NOT NULL,
  success          BOOLEAN NOT NULL,

  -- Meta error envelope
  meta_code        INTEGER,
  meta_subcode     INTEGER,
  meta_type        TEXT,
  meta_user_msg    TEXT,
  meta_user_title  TEXT,
  meta_message     TEXT,
  fbtrace_id       TEXT,

  -- Florrie's diagnosis of the meta envelope + suggested next action
  diagnosis        TEXT,
  suggested_action TEXT,
  retry_after      TIMESTAMPTZ,

  -- Full raw payload (for post-mortem when the meta fields miss something)
  raw_response     JSONB,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_diagnostics_beautician_created
  ON whatsapp_diagnostics(beautician_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_whatsapp_diagnostics_failures
  ON whatsapp_diagnostics(created_at DESC)
  WHERE success = false;

-- RLS: beauticians read their own diagnostic trail; server-side inserts bypass
-- via service role key.
ALTER TABLE whatsapp_diagnostics ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "beauticians_own_whatsapp_diagnostics" ON whatsapp_diagnostics;
CREATE POLICY "beauticians_own_whatsapp_diagnostics"
  ON whatsapp_diagnostics
  FOR SELECT
  USING (beautician_id = auth.uid());
