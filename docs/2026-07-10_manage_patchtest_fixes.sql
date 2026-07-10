-- 2026-07-10 — schema fixes applied to prod (Supabase driyreevwogxngqyshtc) via SQL editor.
-- Recovers the manage-booking + patch-test + reschedule flow (was 404/401 for all clients)
-- and adds the configurable patch-test length/price.

-- 1) MISSING COLUMN that broke the whole client manage page (404 "Booking not found")
--    since commit 2c40f50 (2026-07-06) added rescheduled_at usage without the column.
--    The manage GET / reschedule / charge-balance selects reference it; PostgREST
--    errored the whole query when it was absent.
alter table appointments add column if not exists rescheduled_at timestamptz;

-- 2) Configurable patch-test appointment length + price (default 10 min / free).
alter table beauticians
  add column if not exists patch_test_duration_minutes int default 10,
  add column if not exists patch_test_price_cents int default 0;

-- After any column add on Supabase, reload the PostgREST schema cache:
notify pgrst, 'reload schema';

-- NOTE (code fixes shipped alongside, no SQL needed):
--  - booking.js patch-test slots + confirm selects referenced non-existent
--    appointment columns client_name, client_phone -> removed (401 Unauthorized).
--  - patch-test slot generator looked up working_hours with capitalised day keys
--    (workingHours['Fri']) but salons store lowercase ('fri') -> made lookup
--    case-insensitive (was returning "No available slots" for every appointment).
