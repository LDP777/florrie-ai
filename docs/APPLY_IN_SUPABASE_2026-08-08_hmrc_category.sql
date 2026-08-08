-- Apply in the Supabase SQL editor. Optional now, worth doing soon.
--
-- WHAT THIS IS
-- Migration 020_hmrc_categories.sql was written in the repo and never run on
-- production, so expenses.hmrc_category does not exist in the live database.
--
-- WHY THE MONEY PAGE WAS BROKEN
-- PostgREST rejects an entire SELECT if one column in the list is unknown. Five
-- places asked for hmrc_category, so one unapplied migration took down the
-- ledger, the Tax tab, the CSV export, the MTD submission, and adding an
-- expense — all with a 500 and no clue which column was at fault.
--
-- YOU DO NOT NEED TO RUN THIS TO FIX THAT. The backend now asks the database
-- which columns it actually has and leaves out the ones it does not
-- (src/lib/schema-probe.js), so the Money page works either way.
--
-- Running this turns the HMRC categorisation back ON: expenses get tagged to
-- self-assessment boxes, the Tax tab groups by them, and the MTD figures split
-- properly instead of everything landing in "other". The backend picks it up
-- within five minutes, no redeploy.
--
-- Safe to run twice.

ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS hmrc_category TEXT;

-- The CHECK is added separately and tolerantly. Adding it inline fails outright
-- if any existing row already holds a value outside the list, which would leave
-- you with a half-applied migration and a confusing error.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'expenses_hmrc_category_check'
  ) THEN
    ALTER TABLE expenses ADD CONSTRAINT expenses_hmrc_category_check
      CHECK (hmrc_category IS NULL OR hmrc_category IN (
        'cost_of_goods', 'premises', 'admin', 'travel',
        'advertising', 'professional_fees', 'insurance',
        'interest', 'phone', 'other_expenses'
      ));
  END IF;
END $$;

-- Backfill from the category already on each expense.
UPDATE expenses SET hmrc_category = CASE
  WHEN category = 'products'  THEN 'cost_of_goods'
  WHEN category = 'rent'      THEN 'premises'
  WHEN category = 'utilities' THEN 'premises'
  WHEN category = 'travel'    THEN 'travel'
  WHEN category = 'insurance' THEN 'insurance'
  WHEN category = 'marketing' THEN 'advertising'
  WHEN category = 'software'  THEN 'admin'
  ELSE 'other_expenses'
END
WHERE hmrc_category IS NULL;

CREATE INDEX IF NOT EXISTS idx_expenses_hmrc_category
  ON expenses (beautician_id, hmrc_category, date);

-- Check it worked:
--   SELECT hmrc_category, count(*) FROM expenses GROUP BY 1 ORDER BY 2 DESC;
