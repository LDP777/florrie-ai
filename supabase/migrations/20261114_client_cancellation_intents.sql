-- Cancel and persist the work authorised by that exact cancellation together.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';

CREATE OR REPLACE FUNCTION public.cancel_client_booking(
  p_appointment uuid, p_owner uuid, p_token uuid, p_starts_at timestamptz,
  p_price integer, p_policy jsonb, p_late boolean, p_intents jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a public.appointments; item jsonb; stamp timestamptz;
BEGIN
  SELECT * INTO a FROM public.appointments
    WHERE id=p_appointment AND beautician_id=p_owner AND management_token=p_token FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found' USING ERRCODE='P0002'; END IF;
  IF a.status IN ('cancelled','cancelled_by_client','cancelled_by_beautician') THEN
    RETURN jsonb_build_object('already_cancelled',true);
  END IF;
  IF a.status NOT IN ('confirmed','pending') OR a.starts_at IS DISTINCT FROM p_starts_at
    OR a.price_cents IS DISTINCT FROM p_price OR a.policy_snapshot IS DISTINCT FROM p_policy THEN
    RAISE EXCEPTION 'This booking changed. Reload it before cancelling.' USING ERRCODE='40001';
  END IF;
  IF jsonb_typeof(p_intents) IS DISTINCT FROM 'array' OR jsonb_array_length(p_intents) NOT BETWEEN 1 AND 2 THEN
    RAISE EXCEPTION 'Cancellation delivery is missing' USING ERRCODE='22023';
  END IF;
  stamp:=date_trunc('milliseconds',clock_timestamp());
  UPDATE public.appointments SET status='cancelled',cancelled_at=stamp,late_cancel_charged=coalesce(p_late,false)
    WHERE id=a.id;
  FOR item IN SELECT value FROM jsonb_array_elements(p_intents) LOOP
    IF item->>'action_type' NOT IN ('booking_cancelled','client_cancellation_fee')
       OR item->>'beautician_id' IS DISTINCT FROM a.beautician_id::text
       OR item->>'appointment_id' IS DISTINCT FROM a.id::text THEN
      RAISE EXCEPTION 'Invalid cancellation work' USING ERRCODE='22023';
    END IF;
    INSERT INTO public.ai_actions(id,beautician_id,client_id,appointment_id,action_type,digital_employee,
      outcome,summary,autonomous,notification_sent,details)
    VALUES((item->>'id')::uuid,a.beautician_id,a.client_id,a.id,item->>'action_type',item->>'digital_employee',
      'pending',item->>'summary',true,false,
      coalesce(item->'details','{}'::jsonb)||jsonb_build_object('source','client_manage','cancelled_at',stamp));
  END LOOP;
  RETURN jsonb_build_object('already_cancelled',false,'cancelled_at',stamp);
END $$;
REVOKE ALL ON FUNCTION public.cancel_client_booking(uuid,uuid,uuid,timestamptz,integer,jsonb,boolean,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_client_booking(uuid,uuid,uuid,timestamptz,integer,jsonb,boolean,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
