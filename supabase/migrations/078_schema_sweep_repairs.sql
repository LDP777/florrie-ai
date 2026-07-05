-- 078: applied to prod via SQL editor 2026-07-05 (recorded for history).
-- Schema-vs-code sweep: columns the code has always written/read that never
-- existed, and tables that were never created. Idempotent.

-- rebook reminder QUEUE columns (the cron read reminder_date/sent, the
-- feature wrote client_id/message - none existed; due-date nudges never fired)
ALTER TABLE rebook_reminders ADD COLUMN IF NOT EXISTS client_id uuid REFERENCES clients(id) ON DELETE CASCADE;
ALTER TABLE rebook_reminders ADD COLUMN IF NOT EXISTS appointment_id uuid;
ALTER TABLE rebook_reminders ADD COLUMN IF NOT EXISTS reminder_date date;
ALTER TABLE rebook_reminders ADD COLUMN IF NOT EXISTS message text;
ALTER TABLE rebook_reminders ADD COLUMN IF NOT EXISTS sent boolean DEFAULT false;

-- patch-test tracking columns the whole manage-portal flow depends on
ALTER TABLE patch_tests ADD COLUMN IF NOT EXISTS appointment_id uuid;
ALTER TABLE patch_tests ADD COLUMN IF NOT EXISTS status text DEFAULT 'pending';
ALTER TABLE patch_tests ADD COLUMN IF NOT EXISTS suggested_slot timestamptz;
ALTER TABLE patch_tests ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;
ALTER TABLE patch_tests ADD COLUMN IF NOT EXISTS auto_booked boolean DEFAULT false;
ALTER TABLE patch_tests ALTER COLUMN test_date DROP NOT NULL;

-- patch-test appointments carry no treatment
ALTER TABLE appointments ALTER COLUMN treatment_id DROP NOT NULL;

-- tables the code wrote to that never existed
CREATE TABLE IF NOT EXISTS retail_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  beautician_id uuid NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  name text NOT NULL, description text, price_cents integer NOT NULL,
  image_url text, category text DEFAULT 'general', stock_qty integer DEFAULT 0,
  max_per_order integer DEFAULT 5, is_active boolean DEFAULT true,
  sort_order integer DEFAULT 0,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
);
ALTER TABLE retail_products ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS retail_products_own ON retail_products;
CREATE POLICY retail_products_own ON retail_products FOR ALL USING (beautician_id IN (SELECT id FROM beauticians WHERE auth_id = auth.uid()));

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  beautician_id uuid NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  subscription jsonb NOT NULL, endpoint text UNIQUE,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
);
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS push_subscriptions_own ON push_subscriptions;
CREATE POLICY push_subscriptions_own ON push_subscriptions FOR ALL USING (beautician_id IN (SELECT id FROM beauticians WHERE auth_id = auth.uid()));

CREATE TABLE IF NOT EXISTS email_sends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  beautician_id uuid NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  email_key text, sequence text, subject text, send_at timestamptz,
  status text DEFAULT 'pending', context jsonb, sent_at timestamptz,
  created_at timestamptz DEFAULT now()
);
