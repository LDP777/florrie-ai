-- Apply before the application release. No historical rows are rewritten.
-- Preflight: this query MUST return no rows. Reconcile duplicates manually;
-- do not delete financial history to make the index pass.
-- SELECT stripe_payment_intent_id, count(*), array_agg(id)
-- FROM public.transactions WHERE stripe_payment_intent_id IS NOT NULL
-- AND type IN ('deposit','full_payment','payment_link','payment','no_show_fee','late_cancel_fee')
-- GROUP BY stripe_payment_intent_id HAVING count(*) > 1;
BEGIN;
CREATE UNIQUE INDEX IF NOT EXISTS transactions_stripe_receipt_unique
 ON public.transactions (stripe_payment_intent_id)
 WHERE stripe_payment_intent_id IS NOT NULL
 AND type IN ('deposit','full_payment','payment_link','payment','no_show_fee','late_cancel_fee');

-- One session buys one eligible treatment. Additional treatments are separate
-- bookings; appointment add-ons must not be included in a free package booking.
-- This RPC is service-only. It is additive so the old deployment is unaffected.
CREATE OR REPLACE FUNCTION public.create_package_booking(p_booking jsonb)
RETURNS SETOF public.appointments
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
 cp public.client_packages%ROWTYPE;
 eligible uuid[];
 result public.appointments%ROWTYPE;
 columns_sql text;
BEGIN
 IF p_booking->>'package_redemption' IS DISTINCT FROM 'true' THEN
   RAISE EXCEPTION 'package redemption required';
 END IF;
 IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_booking) k WHERE k NOT IN (
   'beautician_id','client_id','treatment_id','starts_at','ends_at','duration_minutes',
   'buffer_minutes','price_cents','deposit_cents','payment_type','client_notes',
   'booked_via','payment_method','status','client_email','policy_snapshot',
   'payment_expires_at','discount_meta','discount_cents','photo_consent',
   'package_redemption','client_package_id','extra_treatment_ids')) THEN
   RAISE EXCEPTION 'unsupported booking field';
 END IF;
 SELECT * INTO cp FROM public.client_packages
 WHERE id = (p_booking->>'client_package_id')::uuid FOR UPDATE;
 IF NOT FOUND OR cp.beautician_id IS DISTINCT FROM (p_booking->>'beautician_id')::uuid
   OR cp.client_id IS DISTINCT FROM (p_booking->>'client_id')::uuid
   OR cp.status IS DISTINCT FROM 'active' OR cp.sessions_total <= 0
   OR cp.sessions_used IS NULL OR cp.sessions_used < 0 OR cp.sessions_used >= cp.sessions_total
   OR cp.expires_at <= now() THEN
   RAISE EXCEPTION 'package unavailable';
 END IF;
 SELECT treatment_ids INTO eligible FROM public.packages
 WHERE id = cp.package_id AND beautician_id = cp.beautician_id;
 IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM public.treatments WHERE id=(p_booking->>'treatment_id')::uuid AND beautician_id=cp.beautician_id)
   OR (coalesce(cardinality(eligible),0) > 0
   AND NOT ((p_booking->>'treatment_id')::uuid = ANY(eligible)))
   OR coalesce(p_booking->'extra_treatment_ids','[]'::jsonb) <> '[]'::jsonb THEN
   RAISE EXCEPTION 'package treatment not covered';
 END IF;
 IF coalesce((p_booking->>'deposit_cents')::integer,0) <> 0
   OR p_booking->>'status' IS DISTINCT FROM 'confirmed' THEN
   RAISE EXCEPTION 'invalid package booking payment';
 END IF;
 SELECT string_agg(format('%I', k), ',') INTO columns_sql FROM jsonb_object_keys(p_booking) k;
 EXECUTE format('INSERT INTO public.appointments (%s) SELECT %s FROM jsonb_populate_record(NULL::public.appointments, $1) RETURNING *', columns_sql, columns_sql)
 INTO result USING p_booking;
 UPDATE public.client_packages SET sessions_used = sessions_used + 1,
   status = CASE WHEN sessions_used + 1 >= sessions_total THEN 'completed' ELSE status END
 WHERE id = cp.id;
 RETURN NEXT result;
END $$;
REVOKE ALL ON FUNCTION public.create_package_booking(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_package_booking(jsonb) TO service_role;
COMMIT;
