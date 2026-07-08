-- 079: lock down email_sends RLS.
--
-- Context: email_sends is a server-only table. It is written and read
-- exclusively by the backend via the Supabase service-role key (see
-- backend/src/config.js and services/email-sequences.js), which bypasses RLS.
-- The frontend never queries it. So the correct model is: RLS on, and no
-- access for the Data API roles (anon/authenticated).
--
-- This also repairs two earlier drifts:
--   * 022 created a policy `email_sends_own` using `beautician_id = auth.uid()`,
--     which never matched — beauticians map to auth via `auth_id`, not `id`.
--   * 078 recreated the table WITHOUT RLS, which is what Supabase's linter flags.
--
-- Idempotent.

ALTER TABLE public.email_sends ENABLE ROW LEVEL SECURITY;

-- Drop the broken policy from 022 (wrong ownership mapping).
DROP POLICY IF EXISTS email_sends_own ON public.email_sends;

-- Least privilege: the Data API roles get no access. RLS with zero policies
-- already denies all rows; the REVOKE blocks table access outright.
REVOKE ALL ON public.email_sends FROM anon, authenticated;

-- NOTE: to later expose a beautician's own email history to the dashboard,
-- grant SELECT to authenticated and add a policy using the correct mapping:
--   GRANT SELECT ON public.email_sends TO authenticated;
--   CREATE POLICY email_sends_owner_read ON public.email_sends
--     FOR SELECT TO authenticated
--     USING (beautician_id IN (SELECT id FROM beauticians WHERE auth_id = auth.uid()));

-- Same treatment for the other two server-only tables the RLS linter flags.
-- Both are accessed exclusively by the backend via the service role; the
-- frontend reaches them only through the backend API (outbound approval/outbox,
-- Live Activity push), never with anon/authenticated directly.
ALTER TABLE public.outbound_sends       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.live_activity_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.outbound_sends       FROM anon, authenticated;
REVOKE ALL ON public.live_activity_tokens FROM anon, authenticated;
