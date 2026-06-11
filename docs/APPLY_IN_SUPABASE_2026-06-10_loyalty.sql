-- Paste into the Supabase SQL editor (florrie prod), 2026-06-10.
-- Mirrors supabase/migrations/057_loyalty_accrual.sql.
--
-- Loyalty accrual idempotency: the backend now awards points automatically
-- when an appointment is marked completed. This index guarantees at most one
-- automatic 'appointment' award per appointment, even under concurrent calls.

CREATE UNIQUE INDEX IF NOT EXISTS idx_loyalty_points_appointment_award
  ON loyalty_points (appointment_id)
  WHERE appointment_id IS NOT NULL AND reason = 'appointment';
