-- Create promo_codes table for managing discount codes
CREATE TABLE promo_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  discount_type TEXT NOT NULL CHECK (discount_type IN ('percentage', 'fixed')),
  discount_value INTEGER NOT NULL CHECK (discount_value > 0),
  max_uses INTEGER,
  current_uses INTEGER NOT NULL DEFAULT 0,
  valid_from TIMESTAMPTZ NOT NULL,
  valid_until TIMESTAMPTZ NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Unique constraint on code and beautician together (each beautician can have same code text)
  CONSTRAINT unique_code_per_beautician UNIQUE (beautician_id, code)
);

-- Index for fast code lookups
CREATE INDEX idx_promo_codes_beautician_id ON promo_codes(beautician_id);
CREATE INDEX idx_promo_codes_code ON promo_codes(code);
CREATE INDEX idx_promo_codes_is_active ON promo_codes(is_active);

-- RLS: Beauticians can only view/edit their own promo codes
ALTER TABLE promo_codes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Beauticians can view their own promo codes"
  ON promo_codes FOR SELECT
  USING (auth.uid() = (SELECT auth_id FROM beauticians WHERE id = beautician_id));

CREATE POLICY "Beauticians can create promo codes"
  ON promo_codes FOR INSERT
  WITH CHECK (auth.uid() = (SELECT auth_id FROM beauticians WHERE id = beautician_id));

CREATE POLICY "Beauticians can update their own promo codes"
  ON promo_codes FOR UPDATE
  USING (auth.uid() = (SELECT auth_id FROM beauticians WHERE id = beautician_id));

CREATE POLICY "Beauticians can delete their own promo codes"
  ON promo_codes FOR DELETE
  USING (auth.uid() = (SELECT auth_id FROM beauticians WHERE id = beautician_id));

-- Public policy: anyone can view valid promo codes by code (for validation endpoint)
-- This is handled in the backend validation logic, not via RLS
