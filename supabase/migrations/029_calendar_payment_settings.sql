-- Migration 029: calendar_settings and payment_settings JSONB columns on beauticians
-- Enables Settings page to persist Calendar sync toggles, buffer time,
-- payment method toggles, deposit config, and no-show fee settings.

ALTER TABLE beauticians
  ADD COLUMN IF NOT EXISTS calendar_settings JSONB DEFAULT '{
    "buffer_minutes": 10,
    "block_personal": false,
    "push_bookings": true,
    "two_way_sync": false
  }'::jsonb,
  ADD COLUMN IF NOT EXISTS payment_settings JSONB DEFAULT '{
    "require_deposit": false,
    "deposit_amount": "£10",
    "no_show_fee": false,
    "accepted_methods": ["cash"]
  }'::jsonb;

COMMENT ON COLUMN beauticians.calendar_settings IS 'Calendar sync preferences: buffer_minutes, block_personal, push_bookings, two_way_sync';
COMMENT ON COLUMN beauticians.payment_settings IS 'Payment config: require_deposit, deposit_amount, no_show_fee, accepted_methods[]';
