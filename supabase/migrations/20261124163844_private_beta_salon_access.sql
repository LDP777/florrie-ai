BEGIN;
-- Approval is separate from a customer's Auth account and from the editable
-- onboarding-completion timestamp. Preserve established salons once only.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='beauticians' AND column_name='owner_access_approved') THEN
    ALTER TABLE public.beauticians ADD COLUMN owner_access_approved boolean NOT NULL DEFAULT false;
    UPDATE public.beauticians SET owner_access_approved=true
    WHERE onboarding_completed_at IS NOT NULL OR subscription_status='active';
  END IF;
END $$;

-- The existing server-field trigger also protects this new field, because it
-- permits changes only to an explicit list of owner-editable columns.
REVOKE INSERT (owner_access_approved), UPDATE (owner_access_approved) ON public.beauticians FROM PUBLIC,anon,authenticated;
DROP POLICY IF EXISTS approved_salon_access ON public.beauticians;
CREATE POLICY approved_salon_access ON public.beauticians AS RESTRICTIVE FOR ALL TO authenticated
  USING (owner_access_approved AND auth_id=(SELECT auth.uid()))
  WITH CHECK (owner_access_approved AND auth_id=(SELECT auth.uid()));

CREATE OR REPLACE FUNCTION public.require_salon_access_on_write() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='INSERT' AND NEW.owner_access_approved IS NOT TRUE THEN
    RAISE EXCEPTION 'Salon setup is invite only' USING ERRCODE='42501';
  END IF;
  IF TG_OP='UPDATE' AND current_user IN ('authenticated','anon') AND OLD.owner_access_approved IS NOT TRUE THEN
    RAISE EXCEPTION 'Salon access has not been approved' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.require_salon_access_on_write() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS require_salon_access_on_write ON public.beauticians;
CREATE TRIGGER require_salon_access_on_write BEFORE INSERT OR UPDATE ON public.beauticians
  FOR EACH ROW EXECUTE FUNCTION public.require_salon_access_on_write();

-- Existing tenant policies use this helper. Keep its signature and trusted
-- identity lookup, but never resolve an unapproved customer's empty profile.
CREATE OR REPLACE FUNCTION public.get_my_beautician_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT id FROM public.beauticians
  WHERE auth_id=(SELECT auth.uid()) AND owner_access_approved IS TRUE LIMIT 1
$$;
NOTIFY pgrst, 'reload schema';
COMMIT;
