-- 076: applied to prod via SQL editor 2026-07-04 (recorded here for history).
-- The Money quick-log inserted a `description` column that never existed and
-- a 'product_sale' type the CHECK rejected, so every tip/product sale logged
-- from the app silently failed. Idempotent.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_type_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_type_check
  CHECK (type IN (
    'payment', 'deposit', 'no_show_fee', 'refund', 'tip',
    'full_payment', 'payment_link', 'late_cancel_fee', 'product_sale'
  ));
