-- Customer credentials are server-only. Existing phone connections are snapshotted,
-- never moved, re-registered or disconnected by this migration.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
CREATE TABLE IF NOT EXISTS public.whatsapp_connections (
  beautician_id uuid PRIMARY KEY REFERENCES public.beauticians(id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN ('legacy','embedded')),
  phone_id text NOT NULL UNIQUE,
  waba_id text,
  credentials text,
  connected_at timestamptz NOT NULL DEFAULT now(),
  CHECK (mode='legacy' OR (waba_id IS NOT NULL AND credentials IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS public.whatsapp_signup_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  beautician_id uuid NOT NULL REFERENCES public.beauticians(id) ON DELETE CASCADE,
  secret_hash text NOT NULL UNIQUE CHECK (secret_hash ~ '^[a-f0-9]{64}$'),
  platform text NOT NULL CHECK (platform IN ('web','native')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','connected','failed','cancelled')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS whatsapp_signup_salon ON public.whatsapp_signup_sessions(beautician_id,created_at);
CREATE TABLE IF NOT EXISTS public.whatsapp_phone_claims (
  phone_id text PRIMARY KEY,
  session_id uuid NOT NULL UNIQUE REFERENCES public.whatsapp_signup_sessions(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
ALTER TABLE public.whatsapp_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_signup_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_phone_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.whatsapp_connections,public.whatsapp_signup_sessions,public.whatsapp_phone_claims FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.whatsapp_connections,public.whatsapp_signup_sessions,public.whatsapp_phone_claims TO service_role;
INSERT INTO public.whatsapp_connections(beautician_id,mode,phone_id)
SELECT id,'legacy',whatsapp_phone_id FROM public.beauticians
WHERE whatsapp_phone_id IS NOT NULL AND coalesce(wa_provider,'meta') <> 'twilio'
ON CONFLICT (beautician_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.start_whatsapp_signup(p_salon uuid,p_hash text,p_platform text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE new_session_id uuid; salon public.beauticians;
BEGIN
 SELECT * INTO STRICT salon FROM public.beauticians WHERE id=p_salon FOR UPDATE;
 IF salon.whatsapp_connected OR salon.whatsapp_phone_id IS NOT NULL OR salon.twilio_wa_sender IS NOT NULL THEN
   RAISE EXCEPTION 'An existing connection must be disconnected explicitly first';
 END IF;
 UPDATE public.whatsapp_signup_sessions SET status='cancelled' WHERE beautician_id=p_salon AND status IN ('pending','processing');
 DELETE FROM public.whatsapp_phone_claims WHERE session_id IN (SELECT id FROM public.whatsapp_signup_sessions WHERE beautician_id=p_salon);
 INSERT INTO public.whatsapp_signup_sessions(beautician_id,secret_hash,platform,expires_at)
 VALUES(p_salon,p_hash,p_platform,now()+interval '15 minutes') RETURNING id INTO new_session_id;
 RETURN new_session_id;
END $$;
CREATE OR REPLACE FUNCTION public.claim_whatsapp_signup(p_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s public.whatsapp_signup_sessions;
BEGIN
 UPDATE public.whatsapp_signup_sessions SET status='processing'
 WHERE secret_hash=p_hash AND status='pending' AND expires_at>now() RETURNING * INTO s;
 IF NOT FOUND THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('id',s.id,'beautician_id',s.beautician_id,'platform',s.platform);
END $$;
CREATE OR REPLACE FUNCTION public.reserve_whatsapp_phone(p_session uuid,p_phone text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s public.whatsapp_signup_sessions;
BEGIN
 SELECT * INTO s FROM public.whatsapp_signup_sessions WHERE id=p_session AND status='processing' AND expires_at>now() FOR UPDATE;
 IF NOT FOUND OR p_phone !~ '^[0-9]{1,40}$' THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM public.beauticians WHERE whatsapp_phone_id=p_phone)
 OR EXISTS(SELECT 1 FROM public.whatsapp_connections WHERE phone_id=p_phone) THEN RETURN false; END IF;
 DELETE FROM public.whatsapp_phone_claims WHERE expires_at<now();
 INSERT INTO public.whatsapp_phone_claims VALUES(p_phone,p_session,s.expires_at) ON CONFLICT DO NOTHING;
 RETURN EXISTS(SELECT 1 FROM public.whatsapp_phone_claims WHERE phone_id=p_phone AND session_id=p_session);
END $$;
CREATE OR REPLACE FUNCTION public.finish_whatsapp_signup(p_session uuid,p_phone text,p_waba text,p_display_phone text,p_credentials text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s public.whatsapp_signup_sessions; salon_id uuid;
BEGIN
 SELECT beautician_id INTO salon_id FROM public.whatsapp_signup_sessions WHERE id=p_session;
 PERFORM 1 FROM public.beauticians WHERE id=salon_id FOR UPDATE;
 SELECT * INTO s FROM public.whatsapp_signup_sessions WHERE id=p_session AND status='processing' AND expires_at>now() FOR UPDATE;
 IF NOT FOUND OR p_waba !~ '^[0-9]{1,40}$' OR p_credentials IS NULL THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.whatsapp_phone_claims WHERE phone_id=p_phone AND session_id=p_session AND expires_at>now()) THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM public.beauticians WHERE id=salon_id AND (whatsapp_connected OR whatsapp_phone_id IS NOT NULL OR twilio_wa_sender IS NOT NULL)) THEN RETURN false; END IF;
 INSERT INTO public.whatsapp_connections(beautician_id,mode,phone_id,waba_id,credentials)
 VALUES(salon_id,'embedded',p_phone,p_waba,p_credentials);
 UPDATE public.beauticians SET whatsapp_connected=true,whatsapp_phone_id=p_phone,whatsapp_phone=p_display_phone,
 whatsapp_registered_at=now(),wa_provider='meta',whatsapp_pending_phone=NULL,whatsapp_pending_activation=false,
 whatsapp_retry_at=NULL,whatsapp_retry_reason=NULL,whatsapp_retry_attempts=0,whatsapp_retry_exhausted=false WHERE id=salon_id;
 UPDATE public.whatsapp_signup_sessions SET status='connected' WHERE id=p_session;
 DELETE FROM public.whatsapp_phone_claims WHERE session_id=p_session;
 RETURN true;
END $$;
CREATE OR REPLACE FUNCTION public.disconnect_embedded_whatsapp(p_salon uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 PERFORM 1 FROM public.beauticians WHERE id=p_salon FOR UPDATE;
 UPDATE public.whatsapp_signup_sessions SET status='cancelled' WHERE beautician_id=p_salon AND status IN ('pending','processing');
 DELETE FROM public.whatsapp_phone_claims WHERE session_id IN (SELECT id FROM public.whatsapp_signup_sessions WHERE beautician_id=p_salon);
 DELETE FROM public.whatsapp_connections WHERE beautician_id=p_salon AND mode='embedded';
 IF NOT FOUND THEN RETURN false; END IF;
 UPDATE public.beauticians SET whatsapp_connected=false,whatsapp_phone_id=NULL,whatsapp_phone=NULL,
 whatsapp_registered_at=NULL,whatsapp_pending_phone=NULL,whatsapp_pending_activation=false,
 whatsapp_retry_at=NULL,whatsapp_retry_reason=NULL,whatsapp_retry_attempts=0,whatsapp_retry_exhausted=false WHERE id=p_salon;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.start_whatsapp_signup(uuid,text,text),public.claim_whatsapp_signup(text),public.reserve_whatsapp_phone(uuid,text),public.finish_whatsapp_signup(uuid,text,text,text,text),public.disconnect_embedded_whatsapp(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.start_whatsapp_signup(uuid,text,text),public.claim_whatsapp_signup(text),public.reserve_whatsapp_phone(uuid,text),public.finish_whatsapp_signup(uuid,text,text,text,text),public.disconnect_embedded_whatsapp(uuid) TO service_role;
COMMIT;
