-- Add patch test reminder settings to beauticians table
ALTER TABLE beauticians
  ADD COLUMN IF NOT EXISTS patch_test_auto_remind BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS patch_test_remind_days_before INTEGER NOT NULL DEFAULT 7,
  ADD COLUMN IF NOT EXISTS patch_test_block_booking BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN beauticians.patch_test_auto_remind IS 'Whether Florrie auto-sends patch test expiry reminders to clients';
COMMENT ON COLUMN beauticians.patch_test_remind_days_before IS 'How many days before expiry to send the reminder';
COMMENT ON COLUMN beauticians.patch_test_block_booking IS 'Whether to block bookings for tint/lift treatments if patch test has expired';
