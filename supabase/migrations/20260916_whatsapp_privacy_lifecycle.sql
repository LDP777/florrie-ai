-- Additive lifecycle tracking. Legacy connections and salon work records stay intact.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE public.whatsapp_connections ADD COLUMN IF NOT EXISTS subject_hash text CHECK (subject_hash ~ '^[a-f0-9]{64}$');
ALTER TABLE public.whatsapp_signup_sessions ADD COLUMN IF NOT EXISTS subject_hash text CHECK (subject_hash ~ '^[a-f0-9]{64}$');
ALTER TABLE public.whatsapp_signup_sessions ADD COLUMN IF NOT EXISTS waba_hash text CHECK (waba_hash ~ '^[a-f0-9]{64}$');
CREATE TABLE IF NOT EXISTS public.whatsapp_account_links (
 beautician_id uuid NOT NULL REFERENCES public.beauticians(id) ON DELETE CASCADE,
 account_hash text NOT NULL CHECK (account_hash ~ '^[a-f0-9]{64}$'),
 kind text NOT NULL CHECK (kind IN ('user','waba')),
 first_seen_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(beautician_id,account_hash,kind)
);
CREATE INDEX IF NOT EXISTS whatsapp_account_links_hash ON public.whatsapp_account_links(account_hash,kind);
CREATE TABLE IF NOT EXISTS public.whatsapp_privacy_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 account_hash text NOT NULL CHECK (account_hash ~ '^[a-f0-9]{64}$'),
 kind text NOT NULL CHECK (kind IN ('user','waba')),
 action text NOT NULL CHECK (action IN ('deauthorize','delete')),
 event_hash text NOT NULL CHECK (event_hash ~ '^[a-f0-9]{64}$'),
 confirmation_code text NOT NULL UNIQUE CHECK (confirmation_code ~ '^[a-f0-9]{48}$'),
 beautician_ids uuid[] NOT NULL DEFAULT '{}',
 status text NOT NULL CHECK (status IN ('needs_review','completed')),
 issued_at timestamptz NOT NULL,
 requested_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz,
 completion_reference text,
 UNIQUE(kind,action,event_hash)
);
CREATE INDEX IF NOT EXISTS whatsapp_privacy_pending ON public.whatsapp_privacy_requests(requested_at) WHERE status='needs_review';
CREATE INDEX IF NOT EXISTS whatsapp_privacy_account ON public.whatsapp_privacy_requests(account_hash,kind,issued_at);
ALTER TABLE public.whatsapp_account_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_privacy_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.whatsapp_account_links,public.whatsapp_privacy_requests FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.whatsapp_account_links,public.whatsapp_privacy_requests TO service_role;
-- Existing embedded WABAs are enough to route WABA callbacks; never infer a
-- Facebook user from the salon owner, browser input, phone, or legacy token.
INSERT INTO public.whatsapp_account_links(beautician_id,account_hash,kind)
SELECT beautician_id,encode(sha256(convert_to('whatsapp:waba:'||waba_id,'UTF8')),'hex'),'waba'
FROM public.whatsapp_connections WHERE mode='embedded' ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.bind_whatsapp_signup_identity(p_session uuid,p_subject_hash text,p_waba_hash text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s public.whatsapp_signup_sessions; salon_id uuid;
BEGIN
 IF p_subject_hash IS NULL OR p_subject_hash !~ '^[a-f0-9]{64}$' OR p_waba_hash IS NULL OR p_waba_hash !~ '^[a-f0-9]{64}$' THEN RETURN false; END IF;
 -- The callback and bind take identity locks in the same order, then salon.
 PERFORM pg_advisory_xact_lock(hashtextextended('whatsapp:'||p_subject_hash,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('whatsapp:'||p_waba_hash,0));
 SELECT beautician_id INTO salon_id FROM public.whatsapp_signup_sessions WHERE id=p_session;
 PERFORM 1 FROM public.beauticians WHERE id=salon_id FOR UPDATE;
 SELECT * INTO s FROM public.whatsapp_signup_sessions WHERE id=p_session AND status='processing' AND expires_at>now() FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM public.whatsapp_privacy_requests WHERE account_hash IN(p_subject_hash,p_waba_hash) AND issued_at>=date_trunc('second',s.created_at)) THEN RETURN false; END IF;
 UPDATE public.whatsapp_signup_sessions SET subject_hash=p_subject_hash,waba_hash=p_waba_hash WHERE id=p_session;
 INSERT INTO public.whatsapp_account_links(beautician_id,account_hash,kind) VALUES(salon_id,p_subject_hash,'user'),(salon_id,p_waba_hash,'waba') ON CONFLICT DO NOTHING;
 RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.finish_whatsapp_signup(p_session uuid,p_phone text,p_waba text,p_display_phone text,p_credentials text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s public.whatsapp_signup_sessions; salon_id uuid;
BEGIN
 SELECT beautician_id INTO salon_id FROM public.whatsapp_signup_sessions WHERE id=p_session;
 PERFORM 1 FROM public.beauticians WHERE id=salon_id FOR UPDATE;
 SELECT * INTO s FROM public.whatsapp_signup_sessions WHERE id=p_session AND status='processing' AND expires_at>now() FOR UPDATE;
 IF NOT FOUND OR p_waba !~ '^[0-9]{1,40}$' OR p_credentials IS NULL OR s.subject_hash IS NULL
   OR s.waba_hash IS DISTINCT FROM encode(sha256(convert_to('whatsapp:waba:'||p_waba,'UTF8')),'hex') THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM public.whatsapp_privacy_requests WHERE account_hash IN(s.subject_hash,s.waba_hash) AND issued_at>=date_trunc('second',s.created_at)) THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.whatsapp_phone_claims WHERE phone_id=p_phone AND session_id=p_session AND expires_at>now()) THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM public.beauticians WHERE id=salon_id AND (whatsapp_connected OR whatsapp_phone_id IS NOT NULL OR twilio_wa_sender IS NOT NULL)) THEN RETURN false; END IF;
 INSERT INTO public.whatsapp_connections(beautician_id,mode,phone_id,waba_id,credentials,subject_hash)
 VALUES(salon_id,'embedded',p_phone,p_waba,p_credentials,s.subject_hash);
 UPDATE public.beauticians SET whatsapp_connected=true,whatsapp_phone_id=p_phone,whatsapp_phone=p_display_phone,
 whatsapp_registered_at=now(),wa_provider='meta',whatsapp_pending_phone=NULL,whatsapp_pending_activation=false,
 whatsapp_retry_at=NULL,whatsapp_retry_reason=NULL,whatsapp_retry_attempts=0,whatsapp_retry_exhausted=false WHERE id=salon_id;
 UPDATE public.whatsapp_signup_sessions SET status='connected' WHERE id=p_session;
 DELETE FROM public.whatsapp_phone_claims WHERE session_id=p_session;
 RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.request_whatsapp_data_action(p_account_hash text,p_kind text,p_action text,p_issued_at timestamptz,p_event_hash text,p_confirmation_code text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE receipt public.whatsapp_privacy_requests; salon_id uuid; ids uuid[];
BEGIN
 IF p_account_hash IS NULL OR p_account_hash !~ '^[a-f0-9]{64}$' OR p_event_hash IS NULL OR p_event_hash !~ '^[a-f0-9]{64}$'
 OR p_confirmation_code IS NULL OR p_confirmation_code !~ '^[a-f0-9]{48}$' OR p_kind IS NULL OR p_kind NOT IN('user','waba')
 OR p_action IS NULL OR p_action NOT IN('deauthorize','delete') OR p_issued_at IS NULL OR p_issued_at>now()+interval '5 minutes' THEN RAISE EXCEPTION 'Invalid WhatsApp request'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('whatsapp:'||p_account_hash,0));
 SELECT * INTO receipt FROM public.whatsapp_privacy_requests WHERE kind=p_kind AND action=p_action AND event_hash=p_event_hash;
 IF FOUND THEN RETURN jsonb_build_object('confirmation_code',receipt.confirmation_code,'status',receipt.status); END IF;
 SELECT coalesce(array_agg(beautician_id ORDER BY beautician_id),'{}') INTO ids FROM public.whatsapp_account_links WHERE account_hash=p_account_hash AND kind=p_kind;
 FOR salon_id IN SELECT id FROM public.beauticians WHERE id=ANY(ids) ORDER BY id FOR UPDATE LOOP
   UPDATE public.whatsapp_signup_sessions SET status='cancelled'
   WHERE beautician_id=salon_id AND status IN('pending','processing') AND date_trunc('second',created_at)<=p_issued_at
     AND CASE WHEN p_kind='user' THEN subject_hash=p_account_hash ELSE waba_hash=p_account_hash END;
   DELETE FROM public.whatsapp_phone_claims WHERE session_id IN(SELECT id FROM public.whatsapp_signup_sessions WHERE beautician_id=salon_id AND status='cancelled');
   DELETE FROM public.whatsapp_connections WHERE beautician_id=salon_id AND mode='embedded' AND date_trunc('second',connected_at)<=p_issued_at
     AND CASE WHEN p_kind='user' THEN subject_hash=p_account_hash ELSE encode(sha256(convert_to('whatsapp:waba:'||waba_id,'UTF8')),'hex')=p_account_hash END;
   IF FOUND THEN
     UPDATE public.beauticians SET whatsapp_connected=false,whatsapp_phone_id=NULL,whatsapp_phone=NULL,whatsapp_registered_at=NULL,
       whatsapp_pending_phone=NULL,whatsapp_pending_activation=false,whatsapp_retry_at=NULL,whatsapp_retry_reason=NULL,
       whatsapp_retry_attempts=0,whatsapp_retry_exhausted=false WHERE id=salon_id;
   END IF;
 END LOOP;
 -- Unknown signed IDs need a human to resolve. A BISU subject must never be
 -- assumed to be the human Facebook account in a different callback surface.
 INSERT INTO public.whatsapp_privacy_requests(account_hash,kind,action,event_hash,confirmation_code,beautician_ids,status,issued_at,completed_at)
 VALUES(p_account_hash,p_kind,p_action,p_event_hash,p_confirmation_code,ids,
   CASE WHEN p_action='delete' OR cardinality(ids)=0 THEN 'needs_review' ELSE 'completed' END,p_issued_at,
   CASE WHEN p_action='deauthorize' AND cardinality(ids)>0 THEN now() END) RETURNING * INTO receipt;
 RETURN jsonb_build_object('confirmation_code',receipt.confirmation_code,'status',receipt.status);
END $$;
CREATE OR REPLACE FUNCTION public.confirm_whatsapp_data_cleanup(p_request_id uuid,p_reference text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF p_reference IS NULL OR length(trim(p_reference)) NOT BETWEEN 3 AND 200 THEN RAISE EXCEPTION 'Review evidence reference required'; END IF;
 UPDATE public.whatsapp_privacy_requests SET status='completed',completed_at=now(),completion_reference=trim(p_reference)
 WHERE id=p_request_id AND status='needs_review';
 IF NOT FOUND THEN RAISE EXCEPTION 'Pending WhatsApp request not found'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.bind_whatsapp_signup_identity(uuid,text,text),public.request_whatsapp_data_action(text,text,text,timestamptz,text,text),public.confirm_whatsapp_data_cleanup(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bind_whatsapp_signup_identity(uuid,text,text),public.request_whatsapp_data_action(text,text,text,timestamptz,text,text),public.confirm_whatsapp_data_cleanup(uuid,text) TO service_role;
COMMIT;
