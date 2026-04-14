-- ============================================================
-- PATCH TEST EXPIRY SETTING
-- ============================================================
-- Stores the beautician's configured patch test validity period.
-- Default 6 months (UK standard). Replaces the hardcoded value
-- in the booking route so Ellie can change it from the app.

ALTER TABLE beauticians
  ADD COLUMN IF NOT EXISTS patch_test_expiry_months INTEGER NOT NULL DEFAULT 6
    CHECK (patch_test_expiry_months IN (3, 6, 12));

COMMENT ON COLUMN beauticians.patch_test_expiry_months IS
  'How long a patch test result stays valid (months). 3, 6, or 12.';
