BEGIN;
SET LOCAL lock_timeout='3s';
ALTER TABLE public.whatsapp_signup_sessions ADD COLUMN signup_mode text NOT NULL DEFAULT 'cloud_api' CHECK(signup_mode IN ('cloud_api','business_app'));
ALTER TABLE public.whatsapp_connections ADD COLUMN business_app boolean NOT NULL DEFAULT false;
ALTER TABLE public.whatsapp_connections ADD COLUMN app_sync jsonb NOT NULL DEFAULT '{}';
CREATE FUNCTION public.start_whatsapp_app_signup(p_salon uuid,p_hash text,p_platform text) RETURNS uuid
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE result uuid;
BEGIN
 result=public.start_whatsapp_signup(p_salon,p_hash,p_platform);
 UPDATE public.whatsapp_signup_sessions SET signup_mode='business_app' WHERE id=result;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.start_whatsapp_app_signup(uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.start_whatsapp_app_signup(uuid,text,text) TO service_role;
CREATE OR REPLACE FUNCTION public.claim_whatsapp_signup(p_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s public.whatsapp_signup_sessions;
BEGIN
 UPDATE public.whatsapp_signup_sessions SET status='processing'
 WHERE secret_hash=p_hash AND status='pending' AND expires_at>now() RETURNING * INTO s;
 IF NOT FOUND THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('id',s.id,'beautician_id',s.beautician_id,'platform',s.platform,'signup_mode',s.signup_mode);
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
 INSERT INTO public.whatsapp_connections(beautician_id,mode,phone_id,waba_id,credentials,subject_hash,business_app)
 VALUES(salon_id,'embedded',p_phone,p_waba,p_credentials,s.subject_hash,s.signup_mode='business_app');
 UPDATE public.beauticians SET whatsapp_connected=true,whatsapp_phone_id=p_phone,whatsapp_phone=p_display_phone,
 whatsapp_registered_at=now(),wa_provider='meta',whatsapp_pending_phone=NULL,whatsapp_pending_activation=false,
 whatsapp_retry_at=NULL,whatsapp_retry_reason=NULL,whatsapp_retry_attempts=0,whatsapp_retry_exhausted=false WHERE id=salon_id;
 UPDATE public.whatsapp_signup_sessions SET status='connected' WHERE id=p_session;
 DELETE FROM public.whatsapp_phone_claims WHERE session_id=p_session;
 RETURN true;
END $$;


CREATE TABLE public.whatsapp_app_events (
 id text PRIMARY KEY CHECK(id ~ '^[a-f0-9]{64}$'),
 beautician_id uuid NOT NULL REFERENCES public.beauticians(id) ON DELETE CASCADE,
 phone_id text NOT NULL, waba_id text NOT NULL, connected_at timestamptz NOT NULL,
 FOREIGN KEY(beautician_id) REFERENCES public.whatsapp_connections(beautician_id) ON DELETE CASCADE,
 field text NOT NULL CHECK(field IN ('history','smb_app_state_sync','smb_message_echoes')),
 payload text, cursor integer NOT NULL DEFAULT 0, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processed','needs_review')),
 created_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz
);
CREATE INDEX whatsapp_app_events_pending ON public.whatsapp_app_events(created_at) WHERE status='pending';
CREATE INDEX whatsapp_app_events_owner ON public.whatsapp_app_events(beautician_id);
ALTER TABLE public.whatsapp_app_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.whatsapp_app_events FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.whatsapp_app_events TO service_role;
CREATE TABLE public.whatsapp_app_message_keys (
 beautician_id uuid NOT NULL REFERENCES public.beauticians(id) ON DELETE CASCADE,
 provider_id text NOT NULL,
 message_id uuid NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
 PRIMARY KEY(beautician_id,provider_id)
);
CREATE INDEX whatsapp_app_message_keys_message ON public.whatsapp_app_message_keys(message_id);
ALTER TABLE public.whatsapp_app_message_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.whatsapp_app_message_keys FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.whatsapp_app_message_keys TO service_role;
CREATE FUNCTION public.import_whatsapp_app_message(p_owner uuid,p_phone text,p_connected_at timestamptz,p_message jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE client uuid; result uuid; recipient text; sent_at timestamptz;
BEGIN
 PERFORM 1 FROM public.beauticians WHERE id=p_owner FOR UPDATE;
 IF NOT EXISTS(SELECT 1 FROM public.whatsapp_connections WHERE beautician_id=p_owner AND phone_id=p_phone AND connected_at=p_connected_at AND business_app) THEN RETURN NULL; END IF;
 recipient=p_message->>'recipient';
 IF recipient !~ '^[0-9]{7,15}$' OR length(p_message->>'id') NOT BETWEEN 1 AND 512 OR length(p_message->>'body') NOT BETWEEN 1 AND 12000 OR p_message->>'direction' NOT IN ('inbound','outbound') THEN RETURN NULL; END IF;
 sent_at=(p_message->>'at')::timestamptz;
 IF sent_at>now()+interval '5 minutes' OR sent_at<now()-interval '190 days' THEN RETURN NULL; END IF;
 IF EXISTS(SELECT 1 FROM public.whatsapp_app_message_keys WHERE beautician_id=p_owner AND provider_id=p_message->>'id') THEN RETURN NULL; END IF;
 SELECT id INTO result FROM public.messages WHERE beautician_id=p_owner AND channel='whatsapp' AND (external_message_id=p_message->>'id' OR whatsapp_message_id=p_message->>'id') LIMIT 1;
 IF result IS NOT NULL THEN
  INSERT INTO public.whatsapp_app_message_keys VALUES(p_owner,p_message->>'id',result);
  RETURN NULL;
 END IF;
 IF (SELECT count(*) FROM public.clients WHERE beautician_id=p_owner AND (whatsapp_id=recipient OR phone='+'||recipient))>1 THEN RAISE EXCEPTION 'Ambiguous WhatsApp contact'; END IF;
 SELECT id INTO client FROM public.clients WHERE beautician_id=p_owner AND (whatsapp_id=recipient OR phone='+'||recipient) LIMIT 1;
 IF client IS NULL THEN
  INSERT INTO public.clients(beautician_id,first_name,phone,whatsapp_id,preferred_channel,status) VALUES(p_owner,'WhatsApp contact','+'||recipient,recipient,'whatsapp','new') RETURNING id INTO client;
 END IF;
 INSERT INTO public.messages(beautician_id,client_id,channel,direction,content,created_at,ai_handled,authored_by,external_message_id,whatsapp_message_id,send_status)
 VALUES(p_owner,client,'whatsapp',p_message->>'direction',p_message->>'body',sent_at,true,CASE WHEN p_message->>'direction'='outbound' THEN CASE WHEN p_message->>'author'='human' THEN 'human' ELSE 'unknown' END ELSE 'client' END,p_message->>'id',p_message->>'id',CASE WHEN p_message->>'direction'='outbound' THEN 'sent' ELSE NULL END) RETURNING id INTO result;
 INSERT INTO public.whatsapp_app_message_keys VALUES(p_owner,p_message->>'id',result);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.import_whatsapp_app_message(uuid,text,timestamptz,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.import_whatsapp_app_message(uuid,text,timestamptz,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
