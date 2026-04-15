-- 043: Multi-treatment bookings
-- Allows clients to book multiple treatments in a single appointment.
-- The primary treatment is stored in treatment_id (existing column),
-- additional treatment IDs go in extra_treatment_ids for display/reporting.
-- Duration and price on the appointment row are the COMBINED totals.

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS extra_treatment_ids JSONB DEFAULT NULL;

COMMENT ON COLUMN appointments.extra_treatment_ids IS 'Array of additional treatment UUIDs when client books multiple treatments in one session';
