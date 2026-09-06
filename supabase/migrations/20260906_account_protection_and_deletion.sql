-- Apply before deploying the account-deletion worker and API.
BEGIN;
CREATE TABLE IF NOT EXISTS public.account_deletions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_id uuid NOT NULL UNIQUE,
  beautician_id uuid NOT NULL,
  snapshot_encrypted text,
  status_token_hash text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','needs_review','completed')),
  completed_steps jsonb NOT NULL DEFAULT '{}',
  manual_confirmations jsonb NOT NULL DEFAULT '{}',
  pending_step text,
  last_error text,
  lease_token uuid,
  lease_until timestamptz,
  requested_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
-- Intentionally no FK: this record must outlive both profile and auth deletion.
ALTER TABLE public.account_deletions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.account_deletions FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.account_deletions TO service_role;
CREATE INDEX IF NOT EXISTS account_deletions_pending ON public.account_deletions(updated_at) WHERE status <> 'completed';

-- New profiles are created only by authenticated /ensure-profile on the server.
DROP POLICY IF EXISTS beauticians_insert_own ON public.beauticians;
REVOKE ALL PRIVILEGES ON public.beauticians FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.beauticians TO authenticated;
DO $$
DECLARE col text;
DECLARE allowed text[] := ARRAY[
 'first_name','last_name','business_name','phone','avatar_url','booking_slug','timezone','currency','locale',
 'working_hours','tone_model','confidence_threshold','auto_reply_enabled','brand_color','brand_font','logo_url',
 'tagline','address','social_links','google_place_id','google_review_link','notification_prefs','client_reminder_prefs',
 'onboarding_completed_at','booking_policy','deposit_required','deposit_percentage','cancellation_policy',
 'no_show_fee_enabled','no_show_fee_percent','payment_settings','calendar_settings','instagram_dm_mode',
 'instagram_auto_redirect_message','business_type','vat_registered','vat_number','marketing_emails_enabled','autonomy',
 'patch_test_expiry_months','patch_test_auto_remind','patch_test_remind_days_before','patch_test_block_booking',
 'patch_test_duration_minutes','patch_test_price_cents'
];
BEGIN
  -- Table REVOKE does not remove pre-existing column grants.
  FOR col IN SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='beauticians' LOOP
    EXECUTE format('REVOKE SELECT (%I), INSERT (%I), UPDATE (%I), REFERENCES (%I) ON public.beauticians FROM PUBLIC, anon, authenticated',col,col,col,col);
    IF col = ANY(allowed) THEN EXECUTE format('GRANT UPDATE (%I) ON public.beauticians TO authenticated',col); END IF;
  END LOOP;
END $$;

-- Defence in depth if a future migration accidentally grants whole-row writes.
-- SECURITY INVOKER: current_user must remain the requesting DB role.
CREATE OR REPLACE FUNCTION public.protect_beautician_server_fields() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE allowed text[] := ARRAY[
 'first_name','last_name','business_name','phone','avatar_url','booking_slug','timezone','currency','locale',
 'working_hours','tone_model','confidence_threshold','auto_reply_enabled','brand_color','brand_font','logo_url',
 'tagline','address','social_links','google_place_id','google_review_link','notification_prefs','client_reminder_prefs',
 'onboarding_completed_at','booking_policy','deposit_required','deposit_percentage','cancellation_policy',
 'no_show_fee_enabled','no_show_fee_percent','payment_settings','calendar_settings','instagram_dm_mode',
 'instagram_auto_redirect_message','business_type','vat_registered','vat_number','marketing_emails_enabled','autonomy',
 'patch_test_expiry_months','patch_test_auto_remind','patch_test_remind_days_before','patch_test_block_booking',
 'patch_test_duration_minutes','patch_test_price_cents','updated_at'
];
BEGIN
  IF current_user IN ('authenticated','anon') THEN
    IF TG_OP <> 'UPDATE' OR (to_jsonb(NEW) - allowed) IS DISTINCT FROM (to_jsonb(OLD) - allowed) THEN
      RAISE EXCEPTION 'Server-owned account fields cannot be changed' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' AND EXISTS (SELECT 1 FROM public.account_deletions WHERE auth_id=NEW.auth_id) THEN
    RAISE EXCEPTION 'Account deletion has already been requested' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS protect_beautician_server_fields ON public.beauticians;
CREATE TRIGGER protect_beautician_server_fields BEFORE INSERT OR UPDATE ON public.beauticians
FOR EACH ROW EXECUTE FUNCTION public.protect_beautician_server_fields();

-- Storage API, not SQL DELETE, removes the underlying files. Include old flat
-- objects by owner identity as well as the current salon-prefixed convention.
CREATE OR REPLACE FUNCTION public.account_deletion_storage_objects(p_auth_id uuid, p_beautician_id uuid)
RETURNS TABLE(bucket_id text, name text) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,storage AS $$
 SELECT o.bucket_id, o.name FROM storage.objects o
 WHERE (to_jsonb(o)->>'owner_id')=p_auth_id::text OR (to_jsonb(o)->>'owner')=p_auth_id::text
 OR o.name LIKE p_beautician_id::text || '/%' OR o.name LIKE p_auth_id::text || '/%'
 ORDER BY o.bucket_id,o.name LIMIT 100;
$$;
REVOKE ALL ON FUNCTION public.account_deletion_storage_objects(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_deletion_storage_objects(uuid,uuid) TO service_role;

-- Remove the profile only after its recovery references have been durably saved.
-- Preserve event IDs for replay suppression, but remove their personal payloads.
CREATE OR REPLACE FUNCTION public.erase_deletion_business(p_deletion_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE request public.account_deletions;
BEGIN
 SELECT * INTO STRICT request FROM public.account_deletions WHERE id=p_deletion_id FOR UPDATE;
 IF request.snapshot_encrypted IS NULL AND request.status <> 'completed' THEN RAISE EXCEPTION 'Missing deletion recovery snapshot'; END IF;
 UPDATE public.stripe_events SET beautician_id=NULL, data='{"account_deleted":true}'::jsonb, processed_at=coalesce(processed_at,now())
 WHERE beautician_id=request.beautician_id
 OR data #>> '{data,object,metadata,beautician_id}' = request.beautician_id::text
 OR data #>> '{metadata,beautician_id}' = request.beautician_id::text;
 -- Clear old archive IDs first so a previously restored appointment can be
 -- archived again by the trigger without a primary-key collision.
 DELETE FROM public.deleted_appointments WHERE beautician_id=request.beautician_id;
 DELETE FROM public.beauticians WHERE id=request.beautician_id AND auth_id=request.auth_id;
 -- The appointment BEFORE DELETE audit trigger creates full snapshots during
 -- this cascade. Erase archives afterward, in the same transaction.
 DELETE FROM public.deleted_appointments WHERE beautician_id=request.beautician_id;
END $$;
REVOKE ALL ON FUNCTION public.erase_deletion_business(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.erase_deletion_business(uuid) TO service_role;
-- No client-facing override. An operator records evidence only after revoking
-- access in the provider console; this unlocks the next retry, not completion.
CREATE OR REPLACE FUNCTION public.confirm_deletion_provider(p_deletion_id uuid,p_provider text,p_reference text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF p_provider NOT IN ('google','instagram','whatsapp','accounting','stripe_connect','apple','other_identity','sms') OR length(trim(p_reference)) NOT BETWEEN 3 AND 200 THEN RAISE EXCEPTION 'Provider and evidence reference are required'; END IF;
 UPDATE public.account_deletions SET manual_confirmations=jsonb_set(manual_confirmations,ARRAY[p_provider],jsonb_build_object('reference',trim(p_reference),'confirmed_at',now())),status='pending',updated_at=now()
 WHERE id=p_deletion_id AND status <> 'completed';
 IF NOT FOUND THEN RAISE EXCEPTION 'Incomplete deletion request not found'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.confirm_deletion_provider(uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_deletion_provider(uuid,text,text) TO service_role;
COMMIT;
