-- 012_schema_catchup.sql
-- Brings migrations in line with columns that were added to production ad-hoc
-- (via the Supabase SQL editor / early setup) and never had a migration file,
-- so the schema is fully reproducible from migrations. Every statement is
-- idempotent (ADD COLUMN IF NOT EXISTS) and matches the live production types
-- and defaults exactly, so re-running it is a no-op on prod.

-- Treatment flags that drive the booking gates (patch test + consultation form).
-- These existed in prod but had no migration; the consultation gate DOES fire
-- (verified 2026-07-10: 5 treatments have requires_consultation = true).
ALTER TABLE treatments   ADD COLUMN IF NOT EXISTS requires_consultation boolean DEFAULT false;
ALTER TABLE treatments   ADD COLUMN IF NOT EXISTS requires_patch_test   boolean DEFAULT false;

-- Reschedule tracking. The absence of this column silently 404'd the entire
-- client manage-booking page from 2026-07-06 until it was added on 2026-07-10.
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS rescheduled_at timestamptz;

-- Configurable patch-test appointment (length + price), added 2026-07-10.
ALTER TABLE beauticians  ADD COLUMN IF NOT EXISTS patch_test_duration_minutes integer DEFAULT 10;
ALTER TABLE beauticians  ADD COLUMN IF NOT EXISTS patch_test_price_cents      integer DEFAULT 0;

-- Outbound delivery status, so a message Ellie sends is saved to the thread
-- even if the channel delivery fails (marked 'failed'). Added 2026-07-10.
ALTER TABLE messages     ADD COLUMN IF NOT EXISTS send_status text;
