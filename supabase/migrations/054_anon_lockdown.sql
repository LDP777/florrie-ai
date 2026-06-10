-- 054: Lock down anon access. APPLIED TO PROD 2026-06-10 via SQL editor.
--
-- Prod state found before applying (differed from committed migrations —
-- it had been manually patched with renamed policies, the uncommitted "047"):
--   * beauticians: policy anon_public_booking_read USING (true), but a
--     column-level anon SELECT grant limited reads to 11 safe columns
--     (tokens/Stripe ids NOT readable). Closed entirely anyway.
--   * appointments: policy anon_public_appointment_times let anon SELECT
--     every non-cancelled appointment row (client contact details included),
--     and appointments_insert_public_booking allowed arbitrary anon INSERTs.
--   * treatments: treatments_select_public USING (true).
--
-- The public booking page talks ONLY to the backend API (service role), so
-- the browser anon key needs none of this. signup_waitlist (landing form,
-- anon INSERT only) is intentionally untouched. All statements idempotent.

BEGIN;

-- appointments: anon could read all non-cancelled rows + insert arbitrary rows
DROP POLICY IF EXISTS "anon_public_appointment_times" ON public.appointments;
DROP POLICY IF EXISTS "appointments_insert_public_booking" ON public.appointments;
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.appointments FROM anon;

-- treatments: served to the booking page by GET /api/booking/:slug/page
DROP POLICY IF EXISTS "treatments_select_public" ON public.treatments;
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.treatments FROM anon;

-- beauticians: remove the remaining anon surface entirely
DROP POLICY IF EXISTS "anon_public_booking_read" ON public.beauticians;
DROP POLICY IF EXISTS "beauticians_select_public_booking" ON public.beauticians;
REVOKE SELECT, INSERT, UPDATE, DELETE, REFERENCES ON public.beauticians FROM anon;

COMMIT;

-- Verified in prod 2026-06-10 (SET ROLE anon):
--   select from appointments  -> 42501 permission denied  ✓
--   select from beauticians   -> 42501 permission denied  ✓
--   select from signup_waitlist -> 0 rows (insert-only preserved; live
--     landing form submit re-tested OK)                   ✓
--   florrie.ai/book/florrie-test-studio loads + lists treatments ✓
