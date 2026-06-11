-- 057: loyalty accrual idempotency.
-- Automatic accrual (backend/src/services/loyalty.js) awards points when an
-- appointment is marked completed. The service pre-checks the ledger, but two
-- concurrent completion calls could both pass that check, so enforce at most
-- one automatic 'appointment' award per appointment at the database level.
CREATE UNIQUE INDEX IF NOT EXISTS idx_loyalty_points_appointment_award
  ON loyalty_points (appointment_id)
  WHERE appointment_id IS NOT NULL AND reason = 'appointment';
