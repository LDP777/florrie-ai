-- 010: Extend add_ons table with category, duration, suggest-with, auto-suggest, active flag
-- Run in Supabase SQL editor

ALTER TABLE add_ons
  ADD COLUMN IF NOT EXISTS category      text        DEFAULT 'treatment',
  ADD COLUMN IF NOT EXISTS duration_minutes integer   DEFAULT 0,
  ADD COLUMN IF NOT EXISTS suggest_with  jsonb       DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS auto_suggest  boolean     DEFAULT true,
  ADD COLUMN IF NOT EXISTS is_active     boolean     DEFAULT true,
  ADD COLUMN IF NOT EXISTS price_cents   integer     DEFAULT 0;

-- Migrate existing 'price' (if it was stored in cents as 'price') into price_cents
UPDATE add_ons SET price_cents = price WHERE price_cents = 0 AND price IS NOT NULL;

-- Create appointment_add_ons join table for tracking which add-ons were booked
CREATE TABLE IF NOT EXISTS appointment_add_ons (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  appointment_id  uuid REFERENCES appointments(id) ON DELETE CASCADE,
  add_on_id       uuid REFERENCES add_ons(id) ON DELETE SET NULL,
  price_cents     integer NOT NULL DEFAULT 0,
  created_at      timestamptz DEFAULT now()
);

-- RLS
ALTER TABLE appointment_add_ons ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Beauticians see own appointment add-ons"
  ON appointment_add_ons FOR ALL
  USING (
    appointment_id IN (
      SELECT id FROM appointments WHERE beautician_id = auth.uid()
    )
  );

-- Index for lookups
CREATE INDEX IF NOT EXISTS idx_appointment_add_ons_appt ON appointment_add_ons(appointment_id);
CREATE INDEX IF NOT EXISTS idx_add_ons_beautician ON add_ons(beautician_id);
