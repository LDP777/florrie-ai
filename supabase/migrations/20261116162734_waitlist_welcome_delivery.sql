-- Durable welcome delivery; signup never waits for the email provider.
ALTER TABLE public.waitlist_signups
  ADD COLUMN welcome_status text NOT NULL DEFAULT 'pending'
    CHECK (welcome_status IN ('pending','sending','sent','suppressed','needs_review')),
  ADD COLUMN welcome_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN welcome_claim uuid,
  ADD COLUMN welcome_first_attempt_at timestamptz,
  ADD COLUMN welcome_last_attempt_at timestamptz,
  ADD COLUMN welcome_next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN welcome_sent_at timestamptz,
  ADD COLUMN welcome_message_id text;
CREATE INDEX waitlist_welcome_due_idx ON public.waitlist_signups(welcome_next_attempt_at)
  WHERE welcome_status IN ('pending','sending');

CREATE FUNCTION public.claim_waitlist_welcomes(p_limit integer DEFAULT 5)
RETURNS SETOF public.waitlist_signups
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  UPDATE public.waitlist_signups SET welcome_status='suppressed', welcome_claim=NULL
    WHERE welcome_status IN ('pending','sending')
      AND (is_test OR unsubscribed_at IS NOT NULL OR marketing_consent_at IS NULL);
  -- Resend's idempotency window is 24h. Never automatically retry an
  -- ambiguous send outside that window, even after a long outage.
  UPDATE public.waitlist_signups SET welcome_status='needs_review', welcome_claim=NULL
    WHERE welcome_status IN ('pending','sending')
      AND (welcome_first_attempt_at < now()-interval '23 hours' OR
           (welcome_attempts >= 6 AND welcome_last_attempt_at < now()-interval '5 minutes'));
  RETURN QUERY
  WITH candidates AS (
    SELECT id FROM public.waitlist_signups
    WHERE (welcome_status='pending' AND welcome_next_attempt_at <= now()
        OR welcome_status='sending' AND welcome_last_attempt_at < now()-interval '5 minutes')
      AND welcome_attempts < 6
      AND (welcome_first_attempt_at IS NULL OR welcome_first_attempt_at >= now()-interval '23 hours')
      AND marketing_consent_at IS NOT NULL AND unsubscribed_at IS NULL AND is_test=false
    ORDER BY signed_up_at, id
    LIMIT greatest(1,least(coalesce(p_limit,5),10)) FOR UPDATE SKIP LOCKED
  )
  UPDATE public.waitlist_signups w SET welcome_status='sending', welcome_claim=gen_random_uuid(),
    welcome_attempts=w.welcome_attempts+1,
    welcome_first_attempt_at=coalesce(w.welcome_first_attempt_at,now()), welcome_last_attempt_at=now()
    FROM candidates c WHERE w.id=c.id RETURNING w.*;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_waitlist_welcomes(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_waitlist_welcomes(integer) TO service_role;
NOTIFY pgrst, 'reload schema';
