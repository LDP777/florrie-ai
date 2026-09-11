-- Additive only: existing appointments, answers and access policies stay intact.
BEGIN;
SET LOCAL lock_timeout = '3s';
ALTER TABLE consultation_responses ADD COLUMN IF NOT EXISTS booking_care jsonb;
ALTER TABLE patch_tests ADD COLUMN IF NOT EXISTS parent_appointment_id uuid REFERENCES appointments(id) ON DELETE SET NULL;
ALTER TABLE patch_tests ADD COLUMN IF NOT EXISTS covered_treatment_ids uuid[];
ALTER TABLE patch_tests ADD COLUMN IF NOT EXISTS performed_at timestamptz;
COMMENT ON COLUMN patch_tests.parent_appointment_id IS 'Treatment booking for which this patch-test visit was arranged; appointment_id identifies the patch-test visit.';
COMMENT ON COLUMN patch_tests.performed_at IS 'Recorded application time as a UTC instant; booking a slot does not populate this field.';
COMMENT ON COLUMN consultation_responses.booking_care IS 'Versioned booking preparation, client-reported patch outcome and review state, separate from signed template answers.';
COMMIT;
