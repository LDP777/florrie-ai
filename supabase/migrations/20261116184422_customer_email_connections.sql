BEGIN;
SET LOCAL lock_timeout='3s';
CREATE TABLE public.email_connections (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 beautician_id uuid NOT NULL UNIQUE REFERENCES public.beauticians(id) ON DELETE CASCADE,
 provider text NOT NULL CHECK(provider IN ('google','microsoft')),
 account_subject text NOT NULL,
 email text NOT NULL,
 credentials text,
 generation uuid NOT NULL DEFAULT gen_random_uuid(),
 status text NOT NULL CHECK(status IN ('connected','reconnect','disconnected')),
 ai_drafts boolean NOT NULL DEFAULT false,
 ai_consent_version text,
 ai_preference_updated_at timestamptz NOT NULL DEFAULT now(),
 client_emails_only boolean NOT NULL DEFAULT true,
 connected_at timestamptz NOT NULL DEFAULT now(),
 sync_after timestamptz NOT NULL DEFAULT now(),
 sync_cursor text,
 sync_started_at timestamptz,
 last_checked_at timestamptz,
 last_synced_at timestamptz,
 error_code text,
 lease_token uuid,
 lease_until timestamptz
);
CREATE UNIQUE INDEX email_account_owner ON public.email_connections(provider,account_subject) WHERE status <> 'disconnected';
CREATE TABLE public.email_connection_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 beautician_id uuid NOT NULL REFERENCES public.beauticians(id) ON DELETE CASCADE,
 provider text NOT NULL CHECK(provider IN ('google','microsoft')),
 state_hash text NOT NULL UNIQUE CHECK(state_hash ~ '^[a-f0-9]{64}$'),
 verifier text NOT NULL,
 platform text NOT NULL CHECK(platform IN ('web','native')),
 ai_drafts boolean NOT NULL,
 client_emails_only boolean NOT NULL,
 expected_generation uuid,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','connected','cancelled','failed')),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_sessions_owner ON public.email_connection_sessions(beautician_id);
CREATE TABLE public.email_message_links (
 message_id uuid PRIMARY KEY REFERENCES public.messages(id) ON DELETE CASCADE,
 connection_id uuid NOT NULL REFERENCES public.email_connections(id) ON DELETE CASCADE,
 generation uuid NOT NULL,
 account_key text NOT NULL,
 provider_message_id text NOT NULL,
 thread_id text,
 internet_message_id text,
 subject text NOT NULL DEFAULT '',
 sender_email text NOT NULL,
 reply_email text NOT NULL,
 UNIQUE(connection_id,account_key,provider_message_id)
);
CREATE TABLE public.email_reply_attempts (
 inbound_id uuid PRIMARY KEY REFERENCES public.messages(id) ON DELETE CASCADE,
 outbound_id uuid NOT NULL UNIQUE REFERENCES public.messages(id) ON DELETE CASCADE,
 connection_id uuid NOT NULL REFERENCES public.email_connections(id) ON DELETE CASCADE,
 generation uuid NOT NULL,
 status text NOT NULL CHECK(status IN ('sending','accepted','failed','unknown')),
 provider_id text,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_reply_attempts_connection ON public.email_reply_attempts(connection_id);
CREATE INDEX email_connections_next_check ON public.email_connections(last_checked_at) WHERE status='connected';
ALTER TABLE public.email_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_connection_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_message_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_reply_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.email_connections,public.email_connection_sessions,public.email_message_links,public.email_reply_attempts FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.email_connections,public.email_connection_sessions,public.email_message_links,public.email_reply_attempts TO service_role;

CREATE FUNCTION public.start_email_connection(p_owner uuid,p_provider text,p_hash text,p_verifier text,p_platform text,p_ai boolean,p_clients_only boolean) RETURNS uuid
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE result uuid; old_generation uuid;
BEGIN
 PERFORM 1 FROM public.beauticians WHERE id=p_owner FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Owner missing'; END IF;
 SELECT generation INTO old_generation FROM public.email_connections WHERE beautician_id=p_owner;
 UPDATE public.email_connection_sessions SET status='cancelled',verifier='' WHERE beautician_id=p_owner AND status IN ('pending','processing');
 INSERT INTO public.email_connection_sessions(beautician_id,provider,state_hash,verifier,platform,ai_drafts,client_emails_only,expected_generation)
 VALUES(p_owner,p_provider,p_hash,p_verifier,p_platform,p_ai,p_clients_only,old_generation) RETURNING id INTO result;
 RETURN result;
END $$;
CREATE FUNCTION public.finish_email_connection(p_session uuid,p_subject text,p_email text,p_credentials text) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE s public.email_connection_sessions; c public.email_connections;
BEGIN
 SELECT * INTO s FROM public.email_connection_sessions WHERE id=p_session;
 IF NOT FOUND THEN RETURN false; END IF;
 PERFORM 1 FROM public.beauticians WHERE id=s.beautician_id FOR UPDATE;
 SELECT * INTO s FROM public.email_connection_sessions WHERE id=p_session FOR UPDATE;
 IF s.status<>'processing' OR s.expires_at<=now() THEN RETURN false; END IF;
 SELECT * INTO c FROM public.email_connections WHERE beautician_id=s.beautician_id FOR UPDATE;
 IF c.generation IS DISTINCT FROM s.expected_generation THEN RETURN false; END IF;
 IF c.status<>'disconnected' AND (c.provider<>s.provider OR c.account_subject<>p_subject) THEN RETURN false; END IF;
 INSERT INTO public.email_connections(beautician_id,provider,account_subject,email,credentials,status,ai_drafts,ai_consent_version,client_emails_only,last_checked_at)
 VALUES(s.beautician_id,s.provider,p_subject,lower(p_email),p_credentials,'connected',s.ai_drafts,CASE WHEN s.ai_drafts THEN 'anthropic-email-drafts-v1' ELSE NULL END,s.client_emails_only,now())
 ON CONFLICT(beautician_id) DO UPDATE SET provider=excluded.provider,account_subject=excluded.account_subject,email=excluded.email,
 credentials=excluded.credentials,status='connected',generation=gen_random_uuid(),ai_drafts=excluded.ai_drafts,ai_consent_version=excluded.ai_consent_version,ai_preference_updated_at=now(),
 client_emails_only=excluded.client_emails_only,connected_at=now(),
 sync_after=CASE WHEN email_connections.provider=excluded.provider AND email_connections.account_subject=excluded.account_subject THEN email_connections.sync_after ELSE now() END,
 sync_cursor=NULL,sync_started_at=NULL,last_checked_at=now(),last_synced_at=NULL,
 error_code=NULL,lease_token=NULL,lease_until=NULL;
 UPDATE public.email_connection_sessions SET status='connected',verifier='' WHERE id=s.id;
 RETURN true;
END $$;
CREATE FUNCTION public.disconnect_email_connection(p_owner uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
BEGIN
 PERFORM 1 FROM public.beauticians WHERE id=p_owner FOR UPDATE;
 UPDATE public.email_connection_sessions SET status='cancelled',verifier='' WHERE beautician_id=p_owner AND status IN ('pending','processing');
 UPDATE public.email_connections SET status='disconnected',credentials=NULL,generation=gen_random_uuid(),lease_token=NULL,lease_until=NULL,error_code=NULL WHERE beautician_id=p_owner;
 RETURN true;
END $$;
CREATE FUNCTION public.claim_email_connection(p_owner uuid,p_lease uuid) RETURNS SETOF public.email_connections
LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
 UPDATE public.email_connections SET lease_token=p_lease,lease_until=now()+interval '5 minutes'
 WHERE beautician_id=p_owner AND status='connected' AND (lease_until IS NULL OR lease_until<now()) RETURNING *;
$$;
-- Import and link together, checking the same owner, active generation and worker lease.
CREATE FUNCTION public.import_mailbox_message(p_connection uuid,p_generation uuid,p_lease uuid,p_mail jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE c public.email_connections; client uuid; result uuid; matches integer;
BEGIN
 SELECT * INTO c FROM public.email_connections WHERE id=p_connection FOR UPDATE;
 IF NOT FOUND OR c.status<>'connected' OR c.generation<>p_generation OR c.lease_token IS DISTINCT FROM p_lease OR c.lease_until<=now() THEN RAISE EXCEPTION 'Connection changed'; END IF;
 IF length(p_mail->>'body') NOT BETWEEN 1 AND 12000 OR length(p_mail->>'id') NOT BETWEEN 1 AND 1024 THEN RAISE EXCEPTION 'Invalid message'; END IF;
 IF (p_mail->>'at')::timestamptz<c.sync_after OR lower(p_mail->>'from')=c.email THEN RETURN NULL; END IF;
 IF EXISTS(SELECT 1 FROM public.email_message_links WHERE connection_id=c.id AND account_key=c.provider||':'||c.account_subject AND provider_message_id=p_mail->>'id') THEN RETURN NULL; END IF;
 SELECT count(*) INTO matches FROM public.clients WHERE beautician_id=c.beautician_id AND lower(email)=lower(p_mail->>'from');
 IF matches>1 THEN RAISE EXCEPTION 'Email matches multiple clients'; END IF;
 SELECT id INTO client FROM public.clients WHERE beautician_id=c.beautician_id AND lower(email)=lower(p_mail->>'from');
 IF client IS NULL AND c.client_emails_only THEN RETURN NULL; END IF;
 IF client IS NULL THEN
  INSERT INTO public.clients(beautician_id,first_name,email,preferred_channel,status)
  VALUES(c.beautician_id,split_part(p_mail->>'from','@',1),lower(p_mail->>'from'),'email','new') RETURNING id INTO client;
 END IF;
 INSERT INTO public.messages(beautician_id,client_id,channel,direction,content,created_at,ai_handled,authored_by,external_message_id)
 VALUES(c.beautician_id,client,'email','inbound',CASE WHEN coalesce(p_mail->>'subject','')='' THEN '' ELSE 'Subject: '||(p_mail->>'subject')||E'\n\n' END||(p_mail->>'body'),(p_mail->>'at')::timestamptz,true,'client','mailbox:'||c.id||':'||(p_mail->>'id')) RETURNING id INTO result;
 INSERT INTO public.email_message_links(message_id,connection_id,generation,account_key,provider_message_id,thread_id,internet_message_id,subject,sender_email,reply_email)
 VALUES(result,c.id,c.generation,c.provider||':'||c.account_subject,p_mail->>'id',p_mail->>'threadId',p_mail->>'internetId',coalesce(p_mail->>'subject',''),lower(p_mail->>'from'),lower(p_mail->>'reply'));
 RETURN result;
END $$;
-- One deliberate reply per imported message. Unknown transport outcomes cannot be retried blindly.
CREATE FUNCTION public.prepare_mailbox_reply(p_owner uuid,p_inbound uuid,p_generation uuid,p_body text,p_author text) RETURNS uuid
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE c public.email_connections; m public.messages; link public.email_message_links; prior public.email_reply_attempts; result uuid;
BEGIN
 SELECT * INTO c FROM public.email_connections WHERE beautician_id=p_owner FOR UPDATE;
 IF NOT FOUND OR c.status<>'connected' OR c.generation<>p_generation THEN RAISE EXCEPTION 'Connection changed'; END IF;
 SELECT * INTO m FROM public.messages WHERE id=p_inbound AND beautician_id=p_owner AND direction='inbound' AND channel='email' FOR UPDATE;
 SELECT * INTO link FROM public.email_message_links WHERE message_id=m.id AND connection_id=c.id;
 IF link.message_id IS NULL OR link.account_key<>c.provider||':'||c.account_subject THEN RAISE EXCEPTION 'Reconnect changed this email thread; reply in your email app'; END IF;
 IF length(trim(p_body)) NOT BETWEEN 1 AND 10000 OR p_author NOT IN ('human','ai','ai_edited') THEN RAISE EXCEPTION 'Invalid reply'; END IF;
 SELECT * INTO prior FROM public.email_reply_attempts WHERE inbound_id=p_inbound;
 IF FOUND THEN
  IF prior.status<>'failed' THEN RETURN NULL; END IF;
  result=prior.outbound_id;
  UPDATE public.messages SET content=p_body,authored_by=p_author,send_status='pending' WHERE id=result;
  UPDATE public.email_reply_attempts SET status='sending',created_at=now() WHERE inbound_id=p_inbound;
 ELSE
  INSERT INTO public.messages(beautician_id,client_id,channel,direction,content,ai_handled,authored_by,send_status)
  VALUES(p_owner,m.client_id,'email','outbound',p_body,p_author<>'human',p_author,'pending') RETURNING id INTO result;
  INSERT INTO public.email_reply_attempts(inbound_id,outbound_id,connection_id,generation,status) VALUES(p_inbound,result,c.id,c.generation,'sending');
 END IF;
 RETURN result;
END $$;
CREATE FUNCTION public.finish_mailbox_reply(p_outbound uuid,p_status text,p_provider_id text) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE attempt public.email_reply_attempts;
BEGIN
 IF p_status NOT IN ('accepted','failed','unknown') THEN RAISE EXCEPTION 'Invalid status'; END IF;
 SELECT * INTO attempt FROM public.email_reply_attempts WHERE outbound_id=p_outbound FOR UPDATE;
 IF NOT FOUND OR attempt.status<>'sending' THEN RETURN false; END IF;
 UPDATE public.email_reply_attempts SET status=p_status,provider_id=p_provider_id WHERE outbound_id=p_outbound;
 UPDATE public.messages SET send_status=CASE p_status WHEN 'accepted' THEN 'sent' WHEN 'failed' THEN 'failed' ELSE 'unconfirmed' END,
 external_message_id=p_provider_id WHERE id=p_outbound;
 IF p_status='accepted' THEN UPDATE public.messages SET resolved=true,resolved_at=now() WHERE id=attempt.inbound_id; END IF;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.import_mailbox_message(uuid,uuid,uuid,jsonb),public.prepare_mailbox_reply(uuid,uuid,uuid,text,text),public.finish_mailbox_reply(uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.import_mailbox_message(uuid,uuid,uuid,jsonb),public.prepare_mailbox_reply(uuid,uuid,uuid,text,text),public.finish_mailbox_reply(uuid,text,text) TO service_role;
REVOKE ALL ON FUNCTION public.start_email_connection(uuid,text,text,text,text,boolean,boolean),public.finish_email_connection(uuid,text,text,text),public.disconnect_email_connection(uuid),public.claim_email_connection(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.start_email_connection(uuid,text,text,text,text,boolean,boolean),public.finish_email_connection(uuid,text,text,text),public.disconnect_email_connection(uuid),public.claim_email_connection(uuid,uuid) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
