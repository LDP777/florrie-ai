-- Only blocks explicitly confirmed through the new suggestion flow receive a
-- suggestion_key. Existing manual blocks and appointments are unchanged.
BEGIN;
ALTER TABLE public.hours_exceptions ADD COLUMN IF NOT EXISTS suggestion_key text;
CREATE UNIQUE INDEX IF NOT EXISTS hours_exception_suggestion_once
  ON public.hours_exceptions(beautician_id, suggestion_key) WHERE suggestion_key IS NOT NULL;

CREATE OR REPLACE FUNCTION public.guard_suggested_time_booking()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.status IN ('cancelled','cancelled_by_client','cancelled_by_beautician','no_show','completed') THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.beautician_id = OLD.beautician_id AND NEW.starts_at = OLD.starts_at AND NEW.ends_at = OLD.ends_at AND NEW.status = OLD.status THEN RETURN NEW; END IF;
  END IF;
  -- Same tenant lock as the confirmed block: concurrent public bookings cannot
  -- pass an earlier availability check and land inside newly protected time.
  PERFORM pg_advisory_xact_lock(hashtextextended('thoughtful-time:' || NEW.beautician_id::text, 0));
  IF EXISTS (
    SELECT 1 FROM public.hours_exceptions h
    WHERE h.beautician_id = NEW.beautician_id AND h.suggestion_key IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM generate_series(
          GREATEST(h.date,(NEW.starts_at AT TIME ZONE 'UTC')::date)::timestamp,
          LEAST(COALESCE(h.end_date,h.date),(NEW.ends_at AT TIME ZONE 'UTC')::date)::timestamp,
          interval '1 day') AS d(day)
        WHERE (NEW.starts_at AT TIME ZONE 'UTC') < (d.day::date + COALESCE(h.end_time,'24:00'::time))
          AND (NEW.ends_at AT TIME ZONE 'UTC') > (d.day::date + COALESCE(h.start_time,'00:00'::time))
      )
  ) THEN RAISE EXCEPTION 'This time is protected in the diary' USING ERRCODE = '23P01'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS guard_suggested_time_booking ON public.appointments;
CREATE TRIGGER guard_suggested_time_booking BEFORE INSERT OR UPDATE OF starts_at, ends_at, status, beautician_id
  ON public.appointments FOR EACH ROW EXECUTE FUNCTION public.guard_suggested_time_booking();

CREATE OR REPLACE FUNCTION public.confirm_suggested_time(
  p_owner uuid, p_key text, p_date date, p_start time, p_end time, p_note text, p_reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE
  v_existing public.hours_exceptions%ROWTYPE;
  v_id uuid;
  v_today date;
  v_start timestamp;
  v_end timestamp;
BEGIN
  SELECT (clock_timestamp() AT TIME ZONE COALESCE(timezone,'Europe/London'))::date INTO v_today FROM public.beauticians WHERE id=p_owner;
  IF v_today IS NULL OR p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 180
    OR p_note IS NULL OR length(p_note)>300 OR p_reason IS NULL OR p_reason NOT IN ('personal','bank_holiday')
    OR p_date IS NULL OR p_date<v_today OR p_date>v_today+365
    OR ((p_start IS NULL) <> (p_end IS NULL)) OR (p_start IS NOT NULL AND p_end<=p_start)
  THEN RAISE EXCEPTION 'Invalid suggested time' USING ERRCODE='22023'; END IF;
  v_start := p_date + COALESCE(p_start,'00:00'::time);
  v_end := p_date + COALESCE(p_end,'24:00'::time);
  IF v_start <= (clock_timestamp() AT TIME ZONE (SELECT COALESCE(timezone,'Europe/London') FROM public.beauticians WHERE id=p_owner))
  THEN RAISE EXCEPTION 'This time has passed' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('thoughtful-time:' || p_owner::text,0));
  SELECT * INTO v_existing FROM public.hours_exceptions WHERE beautician_id=p_owner AND suggestion_key=p_key;
  IF FOUND THEN
    IF v_existing.date=p_date AND v_existing.start_time IS NOT DISTINCT FROM p_start AND v_existing.end_time IS NOT DISTINCT FROM p_end
    THEN RETURN jsonb_build_object('ok',true,'already_done',true,'block_id',v_existing.id); END IF;
    RAISE EXCEPTION 'This block has since been edited. Check the diary.' USING ERRCODE='40001';
  END IF;
  IF EXISTS (SELECT 1 FROM public.appointments a WHERE a.beautician_id=p_owner
    AND a.status NOT IN ('cancelled','cancelled_by_client','cancelled_by_beautician','no_show','completed')
    AND (a.starts_at AT TIME ZONE 'UTC')<v_end AND (a.ends_at AT TIME ZONE 'UTC')>v_start)
  THEN RAISE EXCEPTION 'A booking now overlaps this time. Nothing was moved.' USING ERRCODE='23P01'; END IF;
  IF EXISTS (SELECT 1 FROM public.hours_exceptions h WHERE h.beautician_id=p_owner
    AND h.date<=p_date AND COALESCE(h.end_date,h.date)>=p_date
    AND p_date+COALESCE(h.start_time,'00:00'::time)<v_end
    AND p_date+COALESCE(h.end_time,'24:00'::time)>v_start)
  THEN RAISE EXCEPTION 'The diary already has a change at this time. Please review it.' USING ERRCODE='23P01'; END IF;
  INSERT INTO public.hours_exceptions(beautician_id,date,type,is_closed,start_time,end_time,custom_start,custom_end,reason,note,notify_clients,suggestion_key)
    VALUES(p_owner,p_date,CASE WHEN p_start IS NULL THEN 'closed' ELSE 'amended' END,p_start IS NULL,p_start,p_end,p_start,p_end,p_reason,p_note,false,p_key) RETURNING id INTO v_id;
  INSERT INTO public.ai_actions(beautician_id,action_type,digital_employee,summary,details,outcome,autonomous)
    VALUES(p_owner,'time_protected','calendar','Protected '||p_date::text||CASE WHEN p_start IS NULL THEN ' for your day off' ELSE ' from '||left(p_start::text,5)||' to '||left(p_end::text,5) END,
      jsonb_build_object('source','florrie_thinks','suggestion_key',p_key,'block_id',v_id,'date',p_date,'start_time',p_start,'end_time',p_end), 'success', false);
  INSERT INTO public.florrie_decisions(beautician_id,suggestion_type,suggestion_payload,response,acted_on)
    VALUES(p_owner,'thoughtful_time',jsonb_build_object('key',p_key,'block_id',v_id,'date',p_date),'yes',true);
  RETURN jsonb_build_object('ok',true,'already_done',false,'block_id',v_id);
END $$;
REVOKE ALL ON FUNCTION public.confirm_suggested_time(uuid,text,date,time,time,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_suggested_time(uuid,text,date,time,time,text,text) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
