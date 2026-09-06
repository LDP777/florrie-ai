-- Apply after account_protection_and_deletion, before deploying its webhook guards.
BEGIN;
ALTER TABLE public.account_deletions ADD COLUMN IF NOT EXISTS billing_reference_hashes text[] NOT NULL DEFAULT '{}';
-- Existing requests must be backfilled from their encrypted snapshot by the
-- server before releasing this change. SQL never receives plaintext credentials.
CREATE OR REPLACE FUNCTION public.deleted_account_event_owner(p_event jsonb)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 WITH payload AS (
  SELECT CASE WHEN jsonb_typeof(p_event #> '{data,object}')='object' THEN p_event #> '{data,object}' ELSE p_event END AS object
 ), identifiers AS (
  SELECT coalesce(object #>> '{metadata,beautician_id}',object #>> '{parent,subscription_details,metadata,beautician_id}') AS beautician,
   ARRAY(SELECT encode(sha256(convert_to(value,'UTF8')),'hex') FROM unnest(ARRAY[
    object->>'id', coalesce(object #>> '{customer,id}',object->>'customer'),
    coalesce(object #>> '{subscription,id}',object->>'subscription'),
    coalesce(object #>> '{parent,subscription_details,subscription,id}',object #>> '{parent,subscription_details,subscription}'),p_event->>'account'
   ]) value WHERE value LIKE 'cus\_%' OR value LIKE 'sub\_%' OR value LIKE 'acct\_%') AS hashes
  FROM payload
 ) SELECT deletion.id FROM public.account_deletions deletion,identifiers
 WHERE deletion.beautician_id::text=identifiers.beautician OR deletion.billing_reference_hashes && identifiers.hashes
 ORDER BY deletion.requested_at LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.deleted_account_event_owner(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.deleted_account_event_owner(jsonb) TO service_role;
CREATE OR REPLACE FUNCTION public.is_deleted_account_event(p_event jsonb)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT public.deleted_account_event_owner(p_event) IS NOT NULL;
$$;
REVOKE ALL ON FUNCTION public.is_deleted_account_event(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.is_deleted_account_event(jsonb) TO service_role;
-- Covers late events and an in-flight handler writing after its initial guard.
CREATE OR REPLACE FUNCTION public.redact_deleted_account_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.data @> '{"account_deleted":true}'::jsonb
 OR public.deleted_account_event_owner(NEW.data) IS NOT NULL
 OR EXISTS(SELECT 1 FROM public.account_deletions WHERE beautician_id=NEW.beautician_id)
 OR (TG_OP='UPDATE' AND (OLD.data @> '{"account_deleted":true}'::jsonb OR public.deleted_account_event_owner(OLD.data) IS NOT NULL)) THEN
  NEW.data='{"account_deleted":true}'::jsonb; NEW.beautician_id=NULL;
  NEW.processed_at=coalesce(NEW.processed_at,now());
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS redact_deleted_account_event ON public.stripe_events;
CREATE TRIGGER redact_deleted_account_event BEFORE INSERT OR UPDATE ON public.stripe_events FOR EACH ROW EXECUTE FUNCTION public.redact_deleted_account_event();
-- Include metadata-less historical events linked by server-owned billing IDs.
CREATE OR REPLACE FUNCTION public.erase_deletion_business(p_deletion_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE request public.account_deletions;
BEGIN
 SELECT * INTO STRICT request FROM public.account_deletions WHERE id=p_deletion_id FOR UPDATE;
 IF request.snapshot_encrypted IS NULL AND request.status <> 'completed' THEN RAISE EXCEPTION 'Missing deletion recovery snapshot'; END IF;
 UPDATE public.stripe_events SET beautician_id=NULL,data='{"account_deleted":true}'::jsonb,processed_at=coalesce(processed_at,now())
 WHERE beautician_id=request.beautician_id OR public.deleted_account_event_owner(data)=request.id;
 DELETE FROM public.beauticians WHERE id=request.beautician_id AND auth_id=request.auth_id;
END $$;
REVOKE ALL ON FUNCTION public.erase_deletion_business(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.erase_deletion_business(uuid) TO service_role;
COMMIT;
