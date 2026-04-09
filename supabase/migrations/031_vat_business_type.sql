-- Migration 031: VAT registration + business type for aestheticians
-- Allows correct tax calculation for sole traders vs limited companies,
-- and tracks approach to the £90k VAT threshold.

ALTER TABLE beauticians
  ADD COLUMN IF NOT EXISTS business_type   TEXT    DEFAULT 'sole_trader',
  ADD COLUMN IF NOT EXISTS vat_registered  BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS vat_number      TEXT;

-- Constrain to valid values
ALTER TABLE beauticians
  ADD CONSTRAINT beauticians_business_type_check
    CHECK (business_type IN ('sole_trader', 'limited_co'));

COMMENT ON COLUMN beauticians.business_type  IS 'sole_trader | limited_co — drives tax calculation model';
COMMENT ON COLUMN beauticians.vat_registered IS 'Whether the business is VAT registered (threshold £90k rolling 12 months)';
COMMENT ON COLUMN beauticians.vat_number     IS 'GB VAT registration number e.g. GB123456789';
