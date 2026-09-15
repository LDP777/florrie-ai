-- Additive intake for verified Instagram requests. Does not delete clients,
-- appointments, messages or sign-in accounts. Cleanup requires recorded review.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE public.beauticians ADD COLUMN IF NOT EXISTS instagram_account_ids text[];
ALTER TABLE public.beauticians ADD COLUMN IF NOT EXISTS instagram_connected_at timestamptz;
ALTER TABLE public.beauticians ADD COLUMN IF NOT EXISTS instagram_token_expires_at timestamptz;

CREATE TABLE IF NOT EXISTS public.instagram_account_links (
  beautician_id uuid NOT NULL REFERENCES public.beauticians(id) ON DELETE CASCADE,
  account_hash text NOT NULL CHECK (account_hash ~ '^[a-f0-9]{64}$'),
  first_connected_at timestamptz NOT NULL,
  last_connected_at timestamptz NOT NULL,
  PRIMARY KEY (beautician_id, account_hash)
);
CREATE INDEX IF NOT EXISTS instagram_account_links_hash ON public.instagram_account_links(account_hash);
CREATE TABLE IF NOT EXISTS public.instagram_privacy_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_hash text NOT NULL CHECK (account_hash ~ '^[a-f0-9]{64}$'),
  action text NOT NULL CHECK (action IN ('deauthorize','delete')),
  event_hash text NOT NULL CHECK (event_hash ~ '^[a-f0-9]{64}$'),
  confirmation_code text NOT NULL UNIQUE CHECK (confirmation_code ~ '^[a-f0-9]{48}$'),
  beautician_ids uuid[] NOT NULL DEFAULT '{}',
  status text NOT NULL CHECK (status IN ('needs_review','completed')),
  issued_at timestamptz NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  completion_reference text,
  UNIQUE (action,event_hash)
);
CREATE INDEX IF NOT EXISTS instagram_privacy_requests_pending ON public.instagram_privacy_requests(requested_at) WHERE status='needs_review';
ALTER TABLE public.instagram_account_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instagram_privacy_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.instagram_account_links,public.instagram_privacy_requests FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.instagram_account_links,public.instagram_privacy_requests TO service_role;

-- Retain hashed routing references after disconnect, so a later deletion
-- callback can still identify records for review. No credentials are copied.
CREATE OR REPLACE FUNCTION public.remember_instagram_account_links() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE account_id text;
BEGIN
  IF NEW.instagram_page_id IS NOT NULL AND NEW.instagram_page_token IS NOT NULL THEN
    FOR account_id IN SELECT DISTINCT x FROM unnest(array_append(coalesce(NEW.instagram_account_ids,'{}'),NEW.instagram_page_id)) x WHERE x ~ '^\d{1,40}$' LOOP
      INSERT INTO public.instagram_account_links VALUES (NEW.id,encode(sha256(convert_to('instagram:'||account_id,'UTF8')),'hex'),coalesce(NEW.instagram_connected_at,NEW.created_at,now()),coalesce(NEW.instagram_connected_at,NEW.created_at,now()))
      ON CONFLICT (beautician_id,account_hash) DO UPDATE SET last_connected_at=greatest(instagram_account_links.last_connected_at,excluded.last_connected_at);
    END LOOP;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS remember_instagram_account_links ON public.beauticians;
CREATE TRIGGER remember_instagram_account_links AFTER INSERT OR UPDATE OF instagram_page_id,instagram_account_ids,instagram_connected_at ON public.beauticians
FOR EACH ROW EXECUTE FUNCTION public.remember_instagram_account_links();

-- Seed existing references without updating any existing salon profile.
INSERT INTO public.instagram_account_links
SELECT DISTINCT b.id,encode(sha256(convert_to('instagram:'||x,'UTF8')),'hex'),coalesce(b.instagram_connected_at,b.created_at,now()),coalesce(b.instagram_connected_at,b.created_at,now())
FROM public.beauticians b CROSS JOIN LATERAL unnest(array_append(coalesce(b.instagram_account_ids,'{}'),b.instagram_page_id)) x
WHERE b.instagram_page_id IS NOT NULL AND b.instagram_page_token IS NOT NULL AND x ~ '^\d{1,40}$'
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.request_instagram_data_action(p_account_hash text,p_action text,p_issued_at timestamptz,p_event_hash text,p_confirmation_code text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE receipt public.instagram_privacy_requests; salon public.beauticians; ids uuid[];
BEGIN
  IF p_account_hash !~ '^[a-f0-9]{64}$' OR p_event_hash !~ '^[a-f0-9]{64}$' OR p_confirmation_code !~ '^[a-f0-9]{48}$'
    OR p_action NOT IN ('deauthorize','delete') OR p_issued_at IS NULL OR p_issued_at > now()+interval '5 minutes' THEN RAISE EXCEPTION 'Invalid Instagram request'; END IF;
  -- Serialize duplicate callbacks. The signed payload is the retry key.
  PERFORM pg_advisory_xact_lock(hashtextextended('instagram:'||p_action||':'||p_event_hash,0));
  SELECT * INTO receipt FROM public.instagram_privacy_requests WHERE action=p_action AND event_hash=p_event_hash;
  IF FOUND THEN RETURN jsonb_build_object('confirmation_code',receipt.confirmation_code,'status',receipt.status); END IF;
  SELECT coalesce(array_agg(beautician_id ORDER BY beautician_id),'{}') INTO ids FROM public.instagram_account_links WHERE account_hash=p_account_hash;
  -- Lock and recheck the current connection. A callback for an older account
  -- or an authorization predating a reconnect cannot disconnect the new one.
  FOR salon IN SELECT * FROM public.beauticians WHERE id=ANY(ids) ORDER BY id FOR UPDATE LOOP
    IF salon.instagram_page_id IS NOT NULL AND date_trunc('second',coalesce(salon.instagram_connected_at,salon.created_at)) <= p_issued_at
      AND EXISTS (SELECT 1 FROM unnest(array_append(coalesce(salon.instagram_account_ids,'{}'),salon.instagram_page_id)) x WHERE encode(sha256(convert_to('instagram:'||x,'UTF8')),'hex')=p_account_hash) THEN
      UPDATE public.beauticians SET instagram_page_id=NULL,instagram_page_token=NULL,instagram_page_name=NULL,
        instagram_account_ids=NULL,instagram_token_expires_at=NULL,instagram_connected_at=NULL WHERE id=salon.id;
    END IF;
  END LOOP;
  INSERT INTO public.instagram_privacy_requests(account_hash,action,event_hash,confirmation_code,beautician_ids,status,issued_at,completed_at)
  VALUES(p_account_hash,p_action,p_event_hash,p_confirmation_code,ids,CASE WHEN p_action='delete' THEN 'needs_review' ELSE 'completed' END,p_issued_at,CASE WHEN p_action='deauthorize' THEN now() END)
  RETURNING * INTO receipt;
  RETURN jsonb_build_object('confirmation_code',receipt.confirmation_code,'status',receipt.status);
END $$;
REVOKE ALL ON FUNCTION public.request_instagram_data_action(text,text,timestamptz,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.request_instagram_data_action(text,text,timestamptz,text,text) TO service_role;

CREATE OR REPLACE FUNCTION public.confirm_instagram_data_cleanup(p_request_id uuid,p_reference text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF p_reference IS NULL OR length(trim(p_reference)) NOT BETWEEN 3 AND 200 THEN RAISE EXCEPTION 'Cleanup evidence reference required'; END IF;
 UPDATE public.instagram_privacy_requests SET status='completed',completed_at=now(),completion_reference=trim(p_reference)
 WHERE id=p_request_id AND action='delete' AND status='needs_review';
 IF NOT FOUND THEN RAISE EXCEPTION 'Pending Instagram request not found'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.confirm_instagram_data_cleanup(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_instagram_data_cleanup(uuid,text) TO service_role;
COMMIT;
