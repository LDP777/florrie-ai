BEGIN;
SET LOCAL lock_timeout = '3s';
-- Addresses survive account deletion, so an old client's mail can never reach a new salon.
CREATE TABLE public.salon_mailboxes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 beautician_id uuid UNIQUE REFERENCES public.beauticians(id) ON DELETE SET NULL,
 address text NOT NULL UNIQUE CHECK(address=lower(address) AND address ~ '^[a-z0-9][a-z0-9.-]{1,62}@[a-z0-9.-]+$'),
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused')),
 created_at timestamptz NOT NULL DEFAULT now(),
 last_received_at timestamptz
);
CREATE TABLE public.salon_email_events (
 email_id uuid PRIMARY KEY,
 webhook_id text NOT NULL,
 recipients text[] NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','complete','ignored','review')),
 attempts integer NOT NULL DEFAULT 0,
 next_attempt_at timestamptz NOT NULL DEFAULT now(),
 lease_token uuid,
 lease_until timestamptz,
 error_code text,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX salon_email_pending ON public.salon_email_events(next_attempt_at) WHERE status IN ('pending','processing');
CREATE TABLE public.salon_email_links (
 message_id uuid PRIMARY KEY REFERENCES public.messages(id) ON DELETE CASCADE,
 mailbox_id uuid NOT NULL REFERENCES public.salon_mailboxes(id),
 email_id uuid NOT NULL UNIQUE,
 sender_email text NOT NULL,
 reply_email text NOT NULL,
 internet_message_id text,
 subject text NOT NULL,
 reply_allowed boolean NOT NULL DEFAULT false,
 attachment_count integer NOT NULL DEFAULT 0
);
CREATE INDEX salon_email_links_mailbox ON public.salon_email_links(mailbox_id);
CREATE TABLE public.salon_email_replies (
 inbound_id uuid PRIMARY KEY REFERENCES public.messages(id) ON DELETE CASCADE,
 outbound_id uuid NOT NULL UNIQUE REFERENCES public.messages(id) ON DELETE CASCADE,
 mailbox_id uuid NOT NULL REFERENCES public.salon_mailboxes(id),
 status text NOT NULL CHECK(status IN ('sending','accepted','failed','unknown')),
 provider_id text,
 attempt integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX salon_email_replies_mailbox ON public.salon_email_replies(mailbox_id,created_at);
ALTER TABLE public.salon_mailboxes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.salon_email_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.salon_email_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.salon_email_replies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.salon_mailboxes,public.salon_email_events,public.salon_email_links,public.salon_email_replies FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.salon_mailboxes,public.salon_email_events,public.salon_email_links,public.salon_email_replies TO service_role;

CREATE FUNCTION public.claim_salon_email_events(p_lease uuid) RETURNS SETOF public.salon_email_events
LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
 UPDATE public.salon_email_events SET status='processing',lease_token=p_lease,lease_until=now()+interval '5 minutes',attempts=attempts+1
 WHERE email_id IN (SELECT email_id FROM public.salon_email_events WHERE status IN ('pending','processing')
 AND next_attempt_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY next_attempt_at LIMIT 10 FOR UPDATE SKIP LOCKED) RETURNING *;
$$;

CREATE FUNCTION public.import_salon_email(p_mailbox uuid,p_email uuid,p_lease uuid,p_mail jsonb) RETURNS uuid
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE box public.salon_mailboxes; event public.salon_email_events; client uuid; result uuid; matches integer;
BEGIN
 SELECT * INTO box FROM public.salon_mailboxes WHERE id=p_mailbox FOR UPDATE;
 IF box.beautician_id IS NULL OR box.status<>'active' THEN RAISE EXCEPTION 'Mailbox unavailable'; END IF;
 SELECT * INTO event FROM public.salon_email_events WHERE email_id=p_email FOR UPDATE;
 IF event.lease_token IS DISTINCT FROM p_lease OR event.status IS DISTINCT FROM 'processing' OR event.lease_until<=now()
 OR NOT (box.address=ANY(event.recipients)) THEN RAISE EXCEPTION 'Email claim changed'; END IF;
 SELECT message_id INTO result FROM public.salon_email_links WHERE email_id=p_email;
 IF result IS NOT NULL THEN RETURN result; END IF;
 IF length(p_mail->>'body') NOT BETWEEN 1 AND 16000 OR length(p_mail->>'from') NOT BETWEEN 3 AND 254
 OR p_mail->>'from' NOT LIKE '%@%' OR p_mail->>'from'=box.address THEN RAISE EXCEPTION 'Invalid email'; END IF;
 SELECT count(*) INTO matches FROM public.clients WHERE beautician_id=box.beautician_id AND lower(email)=p_mail->>'from';
 IF matches=1 THEN SELECT id INTO client FROM public.clients WHERE beautician_id=box.beautician_id AND lower(email)=p_mail->>'from'; END IF;
 IF client IS NULL THEN
  -- Ambiguous email matches must not expose one existing client's history to another.
  INSERT INTO public.clients(beautician_id,first_name,email,preferred_channel,status)
  VALUES(box.beautician_id,CASE WHEN matches>1 THEN 'Email enquiry' ELSE left(split_part(p_mail->>'from','@',1),80) END,
    CASE WHEN matches>1 THEN NULL ELSE p_mail->>'from' END,'email','new') RETURNING id INTO client;
 END IF;
 INSERT INTO public.messages(beautician_id,client_id,channel,direction,content,ai_handled,authored_by,external_message_id,escalated,escalated_reason)
 VALUES(box.beautician_id,client,'email','inbound','Subject: '||left(coalesce(p_mail->>'subject',''),250)||E'\n\n'||(p_mail->>'body'),
 true,'client','salon-email:'||p_email,true,CASE WHEN matches>1 THEN 'Email address matches multiple clients. Check who is writing.' ELSE 'Email ready for your reply' END) RETURNING id INTO result;
 INSERT INTO public.salon_email_links(message_id,mailbox_id,email_id,sender_email,reply_email,internet_message_id,subject,reply_allowed,attachment_count)
 VALUES(result,box.id,p_email,p_mail->>'from',p_mail->>'reply',p_mail->>'internetId',left(coalesce(p_mail->>'subject',''),250),
 coalesce((p_mail->>'replyAllowed')::boolean,false),(p_mail->>'attachments')::integer);
 UPDATE public.salon_mailboxes SET last_received_at=now() WHERE id=box.id;
 UPDATE public.salon_email_events SET status='complete',lease_token=NULL,lease_until=NULL,error_code=NULL WHERE email_id=p_email;
 RETURN result;
END $$;

CREATE FUNCTION public.prepare_salon_email_reply(p_owner uuid,p_inbound uuid,p_body text,p_author text) RETURNS uuid
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE box public.salon_mailboxes; link public.salon_email_links; m public.messages; prior public.salon_email_replies; result uuid;
BEGIN
 SELECT * INTO box FROM public.salon_mailboxes WHERE beautician_id=p_owner FOR UPDATE;
 IF NOT FOUND OR box.status<>'active' THEN RAISE EXCEPTION 'Mailbox unavailable'; END IF;
 SELECT * INTO m FROM public.messages WHERE id=p_inbound AND beautician_id=p_owner AND direction='inbound' AND channel='email' FOR UPDATE;
 SELECT * INTO link FROM public.salon_email_links WHERE message_id=m.id AND mailbox_id=box.id;
 IF link.message_id IS NULL OR NOT link.reply_allowed OR link.reply_email<>link.sender_email THEN RAISE EXCEPTION 'Email needs review'; END IF;
 IF length(trim(p_body)) NOT BETWEEN 1 AND 10000 OR p_author NOT IN ('human','ai','ai_edited') THEN RAISE EXCEPTION 'Invalid reply'; END IF;
 IF (SELECT count(*) FROM public.salon_email_replies WHERE mailbox_id=box.id AND created_at>now()-interval '24 hours')>=200 THEN RAISE EXCEPTION 'Email daily limit reached'; END IF;
 SELECT * INTO prior FROM public.salon_email_replies WHERE inbound_id=p_inbound;
 IF FOUND THEN
  IF prior.status<>'failed' THEN RETURN NULL; END IF;
  result=prior.outbound_id;
  UPDATE public.messages SET content=p_body,authored_by=p_author,send_status='pending' WHERE id=result;
  UPDATE public.salon_email_replies SET status='sending',attempt=attempt+1,created_at=now() WHERE inbound_id=p_inbound;
 ELSE
  INSERT INTO public.messages(beautician_id,client_id,channel,direction,content,ai_handled,authored_by,send_status)
  VALUES(p_owner,m.client_id,'email','outbound',p_body,p_author<>'human',p_author,'pending') RETURNING id INTO result;
  INSERT INTO public.salon_email_replies(inbound_id,outbound_id,mailbox_id,status) VALUES(p_inbound,result,box.id,'sending');
 END IF;
 RETURN result;
END $$;
CREATE FUNCTION public.finish_salon_email_reply(p_outbound uuid,p_status text,p_provider_id text) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE attempt public.salon_email_replies;
BEGIN
 IF p_status NOT IN ('accepted','failed','unknown') THEN RAISE EXCEPTION 'Invalid status'; END IF;
 SELECT * INTO attempt FROM public.salon_email_replies WHERE outbound_id=p_outbound FOR UPDATE;
 IF NOT FOUND OR attempt.status<>'sending' THEN RETURN false; END IF;
 UPDATE public.salon_email_replies SET status=p_status,provider_id=p_provider_id WHERE outbound_id=p_outbound;
 UPDATE public.messages SET send_status=CASE p_status WHEN 'accepted' THEN 'sent' WHEN 'failed' THEN 'failed' ELSE 'unconfirmed' END,external_message_id=p_provider_id WHERE id=p_outbound;
 IF p_status='accepted' THEN UPDATE public.messages SET resolved=true,resolved_at=now() WHERE id=attempt.inbound_id; END IF;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.claim_salon_email_events(uuid),public.import_salon_email(uuid,uuid,uuid,jsonb),public.prepare_salon_email_reply(uuid,uuid,text,text),public.finish_salon_email_reply(uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_salon_email_events(uuid),public.import_salon_email(uuid,uuid,uuid,jsonb),public.prepare_salon_email_reply(uuid,uuid,text,text),public.finish_salon_email_reply(uuid,text,text) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
