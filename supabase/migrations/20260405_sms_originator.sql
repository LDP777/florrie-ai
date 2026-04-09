-- Add per-beautician SMS originator (alphanumeric sender name, max 11 chars)
-- Shown to clients as the SMS sender name instead of a phone number.
-- Defaults to 'Florrie'; beauticians set their own business name via SMSConfig.

ALTER TABLE beauticians
  ADD COLUMN IF NOT EXISTS sms_originator VARCHAR(11) DEFAULT 'Florrie',
  ADD COLUMN IF NOT EXISTS sms_enabled BOOLEAN DEFAULT false;

-- Update client_reminder_prefs default to include sms as a valid fallback channel
COMMENT ON COLUMN beauticians.sms_originator IS 'Bird/MessageBird alphanumeric sender ID, max 11 chars. Set by beautician in SMS config.';
COMMENT ON COLUMN beauticians.sms_enabled IS 'Whether SMS sending is enabled for this beautician.';
