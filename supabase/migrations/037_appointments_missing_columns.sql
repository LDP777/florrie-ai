-- Migration 037: Add missing columns to appointments + treatments
-- These columns are referenced in booking.js but were never added via migration,
-- causing the appointment INSERT to fail with "Failed to create booking".

-- ─── Appointments: payment + discount + package + consent ─────────────────────

-- Payment method (cash/card/bank_transfer) at booking time
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS payment_method TEXT DEFAULT 'card';

-- Booking-time photo consent (distinct from the full photo_consents GDPR table)
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS photo_consent BOOLEAN DEFAULT false;

-- Discount applied at time of booking
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS discount_meta JSONB;

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS discount_cents INTEGER DEFAULT 0;

-- Package redemption tracking
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS package_redemption BOOLEAN DEFAULT false;

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS client_package_id UUID REFERENCES client_packages(id) ON DELETE SET NULL;

-- ─── Treatments: patch test flag ──────────────────────────────────────────────
-- When true, the public booking page will prompt the client to book a patch test
-- at least 48h before their appointment. Should only be set on dye treatments
-- (brow tints, lash tints, HD brows with tint, etc.) — NOT wax, microblading, etc.

ALTER TABLE treatments
  ADD COLUMN IF NOT EXISTS requires_patch_test BOOLEAN DEFAULT false;

COMMENT ON COLUMN treatments.requires_patch_test IS
  'When true, booking page prompts client to book a patch test 48h before appointment. Only for dye/tint treatments.';
