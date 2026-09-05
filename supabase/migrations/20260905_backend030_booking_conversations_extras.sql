-- 030: booking_conversations.extra_treatment_ids
--
-- 5 September 2026. A client on Instagram asked for "brow wax and lip wax"
-- and was asked "Did you mean Brow wax or Lip wax?". She meant both. The
-- booking conversation could only remember one treatment between messages
-- (treatment_id), so it could only ever book one. Same shape as
-- appointments.extra_treatment_ids (migration 043): the second and third
-- treatment, as a JSON array of treatment ids, alongside the first.
--
-- The code probes for this column (backend/src/lib/schema-probe.js). Until
-- it exists, a two-treatment ask is handed to the owner with both
-- treatments named, rather than booked as one. Idempotent, no transaction,
-- applied by hand in the Supabase SQL editor.

ALTER TABLE booking_conversations
  ADD COLUMN IF NOT EXISTS extra_treatment_ids JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN booking_conversations.extra_treatment_ids IS
  'The second and third treatment in the booking being negotiated, as an array of treatment ids, mirroring appointments.extra_treatment_ids. Written by services/conversational-booking.js; probed, so the code works without it.';
