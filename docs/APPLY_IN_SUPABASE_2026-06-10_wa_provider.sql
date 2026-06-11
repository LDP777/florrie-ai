-- PASTE THIS WHOLE FILE INTO THE SUPABASE SQL EDITOR AND RUN IT.
-- Mirrors supabase/migrations/059_wa_provider.sql (Twilio BSP migration).
-- Safe to run twice: everything is IF NOT EXISTS / idempotent.
--
-- After running: Restart (not redeploy) the Railway backend so PgBouncer's
-- schema cache picks up the new columns.

ALTER TABLE beauticians
  ADD COLUMN IF NOT EXISTS wa_provider TEXT DEFAULT 'meta'
    CHECK (wa_provider IN ('meta', 'twilio'));

ALTER TABLE beauticians
  ADD COLUMN IF NOT EXISTS twilio_wa_sender TEXT;

CREATE INDEX IF NOT EXISTS idx_beauticians_twilio_wa_sender
  ON beauticians (twilio_wa_sender)
  WHERE twilio_wa_sender IS NOT NULL;

COMMENT ON COLUMN beauticians.wa_provider IS
  'WhatsApp sending provider: meta (Cloud API direct) or twilio (BSP)';
COMMENT ON COLUMN beauticians.twilio_wa_sender IS
  'Twilio WhatsApp sender address, e.g. whatsapp:+447418313493';
