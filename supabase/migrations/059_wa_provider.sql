-- 059: WhatsApp provider abstraction (Twilio BSP migration, sprint doc
-- docs/ONBOARDING_AT_SCALE_SPRINT_2026-06-10.md).
--
-- Each beautician picks her WhatsApp sending provider:
--   'meta'   = direct Meta Cloud API (today's path, Ellie stays here)
--   'twilio' = Twilio BSP (the 15-minute self-serve onboarding path)
--
-- twilio_wa_sender holds the Twilio WhatsApp sender address exactly as
-- Twilio formats it, e.g. 'whatsapp:+447418313493'. It is the From on
-- outbound sends and the To we match inbound webhooks against.
--
-- Dormant by default: every existing row stays wa_provider='meta' and the
-- backend only routes through Twilio when BOTH the row says 'twilio' AND
-- the TWILIO_* env vars are present.

ALTER TABLE beauticians
  ADD COLUMN IF NOT EXISTS wa_provider TEXT DEFAULT 'meta'
    CHECK (wa_provider IN ('meta', 'twilio'));

ALTER TABLE beauticians
  ADD COLUMN IF NOT EXISTS twilio_wa_sender TEXT;

-- Inbound webhook resolves the tenant by sender address.
CREATE INDEX IF NOT EXISTS idx_beauticians_twilio_wa_sender
  ON beauticians (twilio_wa_sender)
  WHERE twilio_wa_sender IS NOT NULL;

COMMENT ON COLUMN beauticians.wa_provider IS
  'WhatsApp sending provider: meta (Cloud API direct) or twilio (BSP)';
COMMENT ON COLUMN beauticians.twilio_wa_sender IS
  'Twilio WhatsApp sender address, e.g. whatsapp:+447418313493';
