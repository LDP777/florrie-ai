-- Launch leads are separate from salon clients and appointment waiting lists.
ALTER TABLE public.waitlist_signups
  ADD COLUMN IF NOT EXISTS marketing_consent_at timestamptz,
  ADD COLUMN IF NOT EXISTS consent_version text,
  ADD COLUMN IF NOT EXISTS consent_text text,
  ADD COLUMN IF NOT EXISTS attribution jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS unsubscribed_at timestamptz,
  ADD COLUMN IF NOT EXISTS unsubscribe_token uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS waitlist_unsubscribe_token_idx ON public.waitlist_signups(unsubscribe_token);
ALTER TABLE public.waitlist_signups ENABLE ROW LEVEL SECURITY;
-- All writes go through the validated, rate-limited backend. No public list,
-- direct insert, update or TRUNCATE access, even for signed-in salon users.
REVOKE ALL ON public.waitlist_signups FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS anon_can_insert ON public.waitlist_signups;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.waitlist_signups TO service_role;

CREATE OR REPLACE VIEW public.florrie_launch_mailing_list
WITH (security_invoker = true) AS
SELECT email, name, signed_up_at, source,
       attribution->>'utm_source' AS utm_source,
       attribution->>'utm_medium' AS utm_medium,
       attribution->>'utm_campaign' AS utm_campaign,
       marketing_consent_at, consent_version,
       'https://api.florrie.ai/api/waitlist/unsubscribe?token=' || unsubscribe_token::text AS unsubscribe_url
FROM public.waitlist_signups
WHERE marketing_consent_at IS NOT NULL AND unsubscribed_at IS NULL AND is_test = false;
REVOKE ALL ON public.florrie_launch_mailing_list FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.florrie_launch_mailing_list TO service_role;
NOTIFY pgrst, 'reload schema';
