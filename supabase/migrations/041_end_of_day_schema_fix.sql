-- 041: Align end_of_day_reports schema with frontend expectations.
-- Adds granular appointment counts, cash reconciliation columns,
-- and renames 'notes' → keep it but add 'closing_notes' alongside.

ALTER TABLE end_of_day_reports
  ADD COLUMN IF NOT EXISTS total_revenue_cents    INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS appointments_completed INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS appointments_noshow    INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS appointments_cancelled INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cash_expected_cents     INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cash_counted_cents      INTEGER,
  ADD COLUMN IF NOT EXISTS closing_notes           TEXT;

-- Rename existing columns to match frontend naming convention:
-- card_total_cents   → card_taken_cents for clarity
-- total_appointments → appointments_total for consistency with new granular cols
ALTER TABLE end_of_day_reports
  RENAME COLUMN card_total_cents TO card_taken_cents;

ALTER TABLE end_of_day_reports
  RENAME COLUMN total_appointments TO appointments_total;
