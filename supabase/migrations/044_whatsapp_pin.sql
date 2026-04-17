-- 6-digit PIN used for WhatsApp Cloud API two-step verification.
-- Generated server-side at /register, required by Meta's /register endpoint
-- after OTP verification to activate the number for Cloud API use.
ALTER TABLE beauticians
  ADD COLUMN IF NOT EXISTS whatsapp_pin TEXT;
