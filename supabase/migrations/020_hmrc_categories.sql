-- Add HMRC self-assessment category to expenses
ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS hmrc_category TEXT
  CHECK (hmrc_category IN (
    'cost_of_goods', 'premises', 'admin', 'travel',
    'advertising', 'professional_fees', 'insurance',
    'interest', 'phone', 'other_expenses'
  ));

-- Backfill existing expenses with auto-mapped HMRC categories
UPDATE expenses SET hmrc_category = CASE
  WHEN category = 'products' THEN 'cost_of_goods'
  WHEN category = 'rent' THEN 'premises'
  WHEN category = 'utilities' THEN 'premises'
  WHEN category = 'travel' THEN 'travel'
  WHEN category = 'insurance' THEN 'insurance'
  WHEN category = 'marketing' THEN 'advertising'
  WHEN category = 'software' THEN 'admin'
  ELSE 'other_expenses'
END
WHERE hmrc_category IS NULL;

-- Index for tax summary queries grouping by HMRC category
CREATE INDEX IF NOT EXISTS idx_expenses_hmrc_category
  ON expenses (beautician_id, hmrc_category, date);
