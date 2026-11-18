-- These policies were labelled for service_role but omitted TO service_role.
-- Keep owner policies and intentional public catalogue/waitlist access intact.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '20s';

ALTER POLICY "Service role inserts aftercare sends" ON public.aftercare_sends TO service_role;
ALTER POLICY "Service role inserts appointment add-ons" ON public.appointment_add_ons TO service_role;
ALTER POLICY "Service role inserts rule logs" ON public.automation_rule_logs TO service_role;
ALTER POLICY "Service role inserts booking suggestions" ON public.booking_suggestions TO service_role;
ALTER POLICY "service_insert_nudges" ON public.client_nudges TO service_role;
ALTER POLICY "Service role manages enrollments" ON public.follow_up_enrollments TO service_role;
ALTER POLICY "Service role inserts review requests" ON public.review_requests_sent TO service_role;

-- pg_temp must be explicit and last, so temporary relations cannot shadow
-- unqualified table references in these existing functions.
ALTER FUNCTION public.get_my_beautician_id() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.update_updated_at() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.bump_client_last_visit() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.record_deleted_appointment() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.increment_message_usage(uuid,date,integer,text,integer) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.increment_sms_usage(uuid,date,integer,integer) SET search_path = pg_catalog, public, pg_temp;

-- Usage counters are backend-owned, including the price/free-limit arguments.
REVOKE ALL ON FUNCTION public.increment_message_usage(uuid,date,integer,text,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.increment_sms_usage(uuid,date,integer,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_message_usage(uuid,date,integer,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.increment_sms_usage(uuid,date,integer,integer) TO service_role;

-- Trigger functions are not client RPCs. Existing triggers continue to run.
REVOKE ALL ON FUNCTION public.redact_deleted_account_event() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.remember_instagram_account_links() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reserve_stripe_receipt_key() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.redact_deleted_account_event() TO service_role;
GRANT EXECUTE ON FUNCTION public.remember_instagram_account_links() TO service_role;
GRANT EXECUTE ON FUNCTION public.reserve_stripe_receipt_key() TO service_role;

-- get_my_beautician_id is deliberately still callable by anon/authenticated:
-- owner RLS policies use it, and it only returns a row matching auth.uid().
NOTIFY pgrst, 'reload schema';
COMMIT;
