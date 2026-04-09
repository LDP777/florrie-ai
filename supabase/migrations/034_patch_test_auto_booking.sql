-- ============================================================
-- PATCH TEST AUTO-BOOKING
-- ============================================================

/**
 * Add columns to patch_tests table to track auto-booking suggestions and confirmations.
 * This allows the system to suggest available 10-minute patch test slots
 * at least 24 hours before a main appointment requiring a patch test.
 */

ALTER TABLE patch_tests
  ADD COLUMN IF NOT EXISTS appointment_id UUID REFERENCES appointments(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS suggested_slot TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS suggested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS confirmation_deadline TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS auto_booked BOOLEAN DEFAULT false;

-- Index for fast lookup of patch tests by appointment
CREATE INDEX IF NOT EXISTS idx_patch_tests_appointment_id
  ON patch_tests(appointment_id);

-- Anon user can read the new patch test columns (needed for client manage portal)
GRANT SELECT ON patch_tests TO anon;

COMMENT ON COLUMN patch_tests.appointment_id IS
  'Link to the main appointment that requires a patch test';

COMMENT ON COLUMN patch_tests.suggested_slot IS
  'System-suggested 10-minute slot for the patch test (at least 24h before main appointment)';

COMMENT ON COLUMN patch_tests.suggested_at IS
  'Timestamp when the slot suggestion was generated';

COMMENT ON COLUMN patch_tests.confirmed_at IS
  'Timestamp when client confirmed the patch test appointment';

COMMENT ON COLUMN patch_tests.confirmation_deadline IS
  'Deadline for client to confirm the suggested patch test slot';

COMMENT ON COLUMN patch_tests.auto_booked IS
  'Whether this patch test was auto-booked from a suggested slot';
