-- Recurring expenses: the fixed costs that were being retyped every month.
--
-- WHY THIS EXISTS
-- The expenses table has always held one row per receipt, entered by hand.
-- For a solo beautician the majority of her spending is not receipts, it is
-- the same four or five fixed costs every month: rent, insurance, the booking
-- software, the phone. Nothing in the schema knew that a cost repeats, so she
-- had to remember each one and retype it, every month, for ever. Miss a month
-- and the profit figure on the Money page is silently wrong in her favour,
-- which is the worst direction for a number she may hand to an accountant.
--
-- One rule row per repeating cost. A daily job (jobs/register.js
-- "recurring-expenses") turns a due rule into a real expenses row, so every
-- surface that already reads expenses (pulse, tax summary, CSV export,
-- hmrc-mtd) sees generated costs with no changes at all. The rule is the
-- schedule; the expense is still the fact.
--
-- WHY THE ANCHOR FIELDS ARE STORED RATHER THAN DERIVED
-- day_of_month is kept even though next_due_date already implies a day,
-- because month lengths would eat it. Rent on the 31st becomes the 28th in
-- February; if the next date were derived from the previous one, March would
-- stay on the 28th and the 31st would be lost for ever. The anchor is the
-- truth, next_due_date is only a cursor.
--
-- HOW A DOUBLE CHARGE IS PREVENTED
-- The job is idempotent at three levels, and the last one is the only one that
-- cannot race:
--   1. The scheduler elects a single replica per run (compare-and-swap on
--      job_runs), so two containers do not both materialise the same day.
--   2. The job reads expenses for (recurring_expense_id, date) before it
--      inserts, and advances next_due_date with a compare-and-swap against the
--      value it read.
--   3. THIS INDEX. A read-then-write guard is a race by construction; the
--      partial unique index below makes a second row for the same rule on the
--      same date impossible in the database, whatever the application does.
--
-- LEVI: run this in the Supabase SQL editor (idempotent, safe to re-run), then
-- RESTART Railway. Not redeploy: PgBouncer caches the PostgREST schema and a
-- redeploy does not clear it, so the new table would read as missing.

CREATE TABLE IF NOT EXISTS recurring_expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL,
  vendor TEXT,
  description TEXT,
  -- Same vocabulary as expenses.category, deliberately duplicated rather than
  -- referenced: the generated row is inserted straight into expenses, and its
  -- own CHECK would reject anything this table let through.
  category TEXT NOT NULL CHECK (category IN (
    'products', 'rent', 'training', 'travel', 'equipment',
    'insurance', 'marketing', 'software', 'utilities', 'other'
  )),
  frequency TEXT NOT NULL CHECK (frequency IN ('weekly','monthly','yearly')),
  day_of_month INTEGER CHECK (day_of_month BETWEEN 1 AND 31),   -- monthly/yearly anchor
  day_of_week INTEGER CHECK (day_of_week BETWEEN 0 AND 6),      -- weekly, 0 = Sunday
  month_of_year INTEGER CHECK (month_of_year BETWEEN 1 AND 12), -- yearly
  next_due_date DATE NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  last_created_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The generated expense knows its parent. ON DELETE SET NULL, never CASCADE:
-- deleting the rule must stop future costs, never erase the ones already
-- spent. Those are her books.
ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS recurring_expense_id UUID
  REFERENCES recurring_expenses(id) ON DELETE SET NULL;

-- The idempotency guarantee. One expense per rule per date, enforced by the
-- database rather than by a read the application does first and hopes about.
CREATE UNIQUE INDEX IF NOT EXISTS idx_expenses_one_per_rule_per_date
  ON expenses (recurring_expense_id, date)
  WHERE recurring_expense_id IS NOT NULL;

-- The job asks exactly one question every day: "which active rules are due?"
CREATE INDEX IF NOT EXISTS idx_recurring_expenses_due
  ON recurring_expenses (next_due_date) WHERE active;

-- The Regular costs list asks the other one: "what does this salon pay?"
CREATE INDEX IF NOT EXISTS idx_recurring_expenses_beautician
  ON recurring_expenses (beautician_id, next_due_date);

-- RLS: the backend uses the service key, which bypasses row level security by
-- design, so this policy protects nothing on the API path. It is here because
-- the app also reads with the anon key, and every sibling table in this schema
-- has one. A table without RLS in a schema where the anon key is live is one
-- forgotten filter away from showing another salon her rent.
ALTER TABLE recurring_expenses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS recurring_expenses_owner ON recurring_expenses;
CREATE POLICY recurring_expenses_owner ON recurring_expenses
  FOR ALL USING (beautician_id = auth.uid());

COMMENT ON TABLE recurring_expenses IS
  'A fixed cost that repeats. The daily recurring-expenses job turns a due rule into a real expenses row; this table is the schedule, expenses is still the record of what was spent.';
COMMENT ON COLUMN recurring_expenses.day_of_month IS
  'The anchor day, 1 to 31. Kept even for a rule whose last run was clamped: rent on the 31st is paid on the 28th of February and the 31st of March, so the anchor must survive the short month.';
COMMENT ON COLUMN recurring_expenses.next_due_date IS
  'Cursor, not truth. The job advances it only once the expense for the current date exists.';
COMMENT ON COLUMN recurring_expenses.last_created_at IS
  'When the job last materialised a row for this rule. Blank means it has never run, which on a rule created today is normal.';
COMMENT ON COLUMN expenses.recurring_expense_id IS
  'Set on rows the recurring-expenses job generated. NULL for anything typed or scanned by hand.';
