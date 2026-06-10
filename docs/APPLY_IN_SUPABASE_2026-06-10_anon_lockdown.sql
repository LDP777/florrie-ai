-- 054: Lock down anon grants left over from the original public-booking design.
-- The public booking page talks ONLY to the backend API (service role), so the
-- browser anon key needs none of these. Before this migration, anyone holding
-- the public anon key could:
--   * SELECT every column of beauticians via the booking_slug policy —
--     including whatsapp_token, instagram_token, google_calendar_tokens,
--     xero_tokens, stripe_account_id, stripe_customer_id
--   * INSERT arbitrary rows into appointments (diary poisoning, fake
--     deposit_paid/confirmed rows, table DoS)
--   * SELECT all treatments directly
--
-- Note: an equivalent beauticians fix may already have been applied to prod
-- manually (the backend code references a "migration 047" that was never
-- committed). This migration makes the lockdown reproducible. Every statement
-- is idempotent.

BEGIN;

-- 1) beauticians: kill the full-row public read
DROP POLICY IF EXISTS "beauticians_select_public_booking" ON public.beauticians;
REVOKE SELECT ON public.beauticians FROM anon;

-- 2) appointments: public bookings are inserted by the backend, never the anon key
DROP POLICY IF EXISTS "appointments_insert_public_booking" ON public.appointments;
REVOKE INSERT ON public.appointments FROM anon;

-- 3) treatments: served to the booking page by GET /api/booking/:slug/page
DROP POLICY IF EXISTS "treatments_select_public" ON public.treatments;
REVOKE SELECT ON public.treatments FROM anon;

COMMIT;

-- Verify (run as a separate statement batch):
--   SET ROLE anon;
--   SELECT * FROM public.beauticians LIMIT 1;   -- expect: permission denied / 0 rows
--   SELECT * FROM public.treatments LIMIT 1;    -- expect: permission denied / 0 rows
--   RESET ROLE;
-- Also confirm the landing-page waitlist still works:
--   signup_waitlist must allow anon INSERT but NOT anon SELECT.
