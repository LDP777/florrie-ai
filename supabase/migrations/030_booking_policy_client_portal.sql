-- Migration 030: Booking policy, client portal tokens, appointment management fields
-- Enables: min booking window, 10-min payment buffer, cancellation policy,
--          client-facing manage-booking portal, patch test + form awareness on booking link

-- ─── 1. Booking policy on beauticians ─────────────────────────────────────────
-- Replaces scattered settings with a unified policy object.
-- All durations in hours/minutes; percents 0-100.
ALTER TABLE beauticians
  ADD COLUMN IF NOT EXISTS booking_policy JSONB DEFAULT '{
    "min_booking_hours": 0,
    "payment_buffer_enabled": false,
    "payment_buffer_minutes": 10,
    "cancellation_notice_hours": 48,
    "late_cancel_charge_percent": 100,
    "rebook_charge_if_late": true,
    "deposit_required": false,
    "deposit_type": "fixed",
    "deposit_amount_cents": 1000,
    "deposit_percent": 25
  }'::jsonb;

COMMENT ON COLUMN beauticians.booking_policy IS
  'Unified booking policy: min window, payment buffer, cancellation rules, deposit config';

-- ─── 2. Appointment management fields ─────────────────────────────────────────
-- management_token: random UUID clients use to access their booking portal
-- payment_expires_at: if payment buffer is on, slot is released after this time
-- cancellation_policy_applied: records what policy was in force when booked
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS management_token UUID DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS payment_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS policy_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS client_email TEXT,
  ADD COLUMN IF NOT EXISTS late_cancel_charged BOOLEAN DEFAULT FALSE;

-- Index for portal lookups by token
CREATE UNIQUE INDEX IF NOT EXISTS appointments_management_token_idx
  ON appointments (management_token)
  WHERE management_token IS NOT NULL;

COMMENT ON COLUMN appointments.management_token IS 'Public token for client self-service portal';
COMMENT ON COLUMN appointments.payment_expires_at IS 'Slot released if unpaid after this timestamp';
COMMENT ON COLUMN appointments.policy_snapshot IS 'Snapshot of cancellation policy at time of booking';
COMMENT ON COLUMN appointments.client_email IS 'Email at time of booking (for portal access without login)';

-- ─── 3. Client portal tokens ──────────────────────────────────────────────────
-- For clients who want to see ALL their bookings/forms (not just one appointment).
-- Email-verified session: we send a magic link, token stored here.
CREATE TABLE IF NOT EXISTS client_portal_tokens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     UUID REFERENCES clients(id) ON DELETE CASCADE,
  beautician_id UUID REFERENCES beauticians(id) ON DELETE CASCADE,
  token         TEXT UNIQUE NOT NULL DEFAULT encode(gen_random_bytes(32), 'hex'),
  email         TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
  used_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS client_portal_tokens_token_idx ON client_portal_tokens (token);
CREATE INDEX IF NOT EXISTS client_portal_tokens_email_idx ON client_portal_tokens (email, beautician_id);

COMMENT ON TABLE client_portal_tokens IS
  'Magic-link tokens for client self-service portal — view all bookings, patch tests, forms';

-- ─── 4. RLS policies ──────────────────────────────────────────────────────────
ALTER TABLE client_portal_tokens ENABLE ROW LEVEL SECURITY;

-- Only service role (backend) can read/write portal tokens
CREATE POLICY "service_role_only" ON client_portal_tokens
  USING (auth.role() = 'service_role');

-- ─── 5. Patch test status view helper ─────────────────────────────────────────
-- Adds a convenience column so booking page can quickly check if a client
-- needs a patch test for a specific treatment type.
ALTER TABLE patch_tests
  ADD COLUMN IF NOT EXISTS treatment_category TEXT;

COMMENT ON COLUMN patch_tests.treatment_category IS
  'Treatment category this patch test covers (e.g. brows, lashes) for cross-treatment matching';
