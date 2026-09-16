-- Keep a managed patch-test visit and its evidence link in the same transaction.
-- No existing rows, policies or legacy patch-booking routes are changed.
BEGIN;
SET LOCAL lock_timeout = '3s';
CREATE OR REPLACE FUNCTION public.book_managed_patch_test(
  p_parent_appointment_id uuid,
  p_beautician_id uuid,
  p_starts_at timestamptz,
  p_create boolean DEFAULT true
) RETURNS TABLE (id uuid, starts_at timestamptz, ends_at timestamptz, already_booked boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  parent public.appointments;
  salon public.beauticians;
  visit public.appointments;
  pending_id uuid;
  duration integer;
  price integer;
  visit_end timestamptz;
  treatment_instant timestamptz;
  patch_instant timestamptz;
  covered uuid[];
BEGIN
  -- Serialises retries for this booking, including concurrent choices of two
  -- different slots. Cancellation/rescheduling must acquire the same row lock.
  SELECT a.* INTO parent FROM public.appointments a
    WHERE a.id = p_parent_appointment_id AND a.beautician_id = p_beautician_id FOR UPDATE;
  IF NOT FOUND OR parent.status NOT IN ('confirmed', 'in_progress') OR parent.client_id IS NULL THEN
    RAISE EXCEPTION 'patch_parent_unavailable';
  END IF;

  SELECT a.* INTO visit FROM public.patch_tests pt
    JOIN public.appointments a ON a.id = pt.appointment_id
    WHERE pt.parent_appointment_id = parent.id AND pt.beautician_id = parent.beautician_id
      AND pt.client_id = parent.client_id AND a.beautician_id = parent.beautician_id
      AND a.client_id = parent.client_id AND a.id <> parent.id AND a.treatment_id IS NULL
      AND a.status IN ('confirmed', 'pending', 'in_progress', 'completed')
    ORDER BY a.created_at, a.id LIMIT 1;
  IF FOUND THEN
    IF visit.starts_at IS DISTINCT FROM p_starts_at THEN RAISE EXCEPTION 'patch_already_booked'; END IF;
    RETURN QUERY SELECT visit.id, visit.starts_at, visit.ends_at, true;
    RETURN;
  END IF;
  -- The route checks a replay before its diary-conflict query. This branch
  -- writes nothing and prevents a lost success response becoming a false 409.
  IF NOT p_create THEN RETURN; END IF;

  SELECT b.* INTO salon FROM public.beauticians b WHERE b.id = parent.beautician_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'patch_parent_unavailable'; END IF;
  duration := coalesce(nullif(salon.patch_test_duration_minutes, 0), 10);
  price := coalesce(salon.patch_test_price_cents, 0);
  IF p_starts_at IS NULL OR duration < 1 OR duration > 240 OR price < 0 THEN
    RAISE EXCEPTION 'patch_configuration_invalid';
  END IF;
  visit_end := p_starts_at + duration * interval '1 minute';
  -- Diary values are salon wall time encoded in UTC-shaped timestamps.
  treatment_instant := (parent.starts_at AT TIME ZONE 'UTC') AT TIME ZONE coalesce(salon.timezone, 'Europe/London');
  patch_instant := (visit_end AT TIME ZONE 'UTC') AT TIME ZONE coalesce(salon.timezone, 'Europe/London');
  IF patch_instant > treatment_instant - interval '48 hours'
    OR ((p_starts_at AT TIME ZONE 'UTC') AT TIME ZONE coalesce(salon.timezone, 'Europe/London')) <= now() THEN
    RAISE EXCEPTION 'patch_time_unavailable';
  END IF;
  -- The public route checks working hours/closures. Recheck diary conflicts
  -- here; the existing appointment exclusion constraint also resolves races.
  IF EXISTS (SELECT 1 FROM public.appointments a WHERE a.beautician_id = parent.beautician_id
    AND a.status IN ('confirmed', 'pending', 'in_progress') AND a.starts_at < visit_end AND a.ends_at > p_starts_at) THEN
    RAISE EXCEPTION 'patch_time_unavailable';
  END IF;
  SELECT array_agg(DISTINCT t) INTO covered FROM (
    SELECT parent.treatment_id AS t
    UNION ALL SELECT value::uuid FROM jsonb_array_elements_text(coalesce(parent.extra_treatment_ids, '[]'::jsonb))
  ) treatments WHERE t IS NOT NULL;

  INSERT INTO public.appointments (beautician_id, client_id, client_email, treatment_id,
    starts_at, ends_at, duration_minutes, status, beautician_notes, booked_via, price_cents)
    VALUES (parent.beautician_id, parent.client_id, parent.client_email, NULL,
      p_starts_at, visit_end, duration, 'confirmed', 'Patch test (auto-booked)', 'booking_page', price)
    RETURNING * INTO visit;

  -- Reuse an unsigned request, including the old placeholder attached to the
  -- main treatment. Preserve completed/performed evidence and cancelled visits.
  SELECT pt.id INTO pending_id FROM public.patch_tests pt
    WHERE pt.beautician_id = parent.beautician_id AND pt.client_id = parent.client_id
      AND (pt.parent_appointment_id = parent.id OR (pt.parent_appointment_id IS NULL AND pt.appointment_id = parent.id))
      AND pt.confirmed_at IS NULL AND pt.performed_at IS NULL
      AND coalesce(pt.result, 'pending') = 'pending'
    ORDER BY pt.created_at, pt.id LIMIT 1 FOR UPDATE;
  IF pending_id IS NOT NULL THEN
    UPDATE public.patch_tests SET appointment_id = visit.id, parent_appointment_id = parent.id,
      covered_treatment_ids = covered, test_date = (p_starts_at AT TIME ZONE 'UTC')::date,
      suggested_slot = p_starts_at, confirmed_at = now(), auto_booked = true, status = 'pending'
      WHERE patch_tests.id = pending_id;
  ELSE
    INSERT INTO public.patch_tests (client_id, beautician_id, appointment_id, parent_appointment_id,
      covered_treatment_ids, test_date, suggested_slot, confirmed_at, auto_booked, status)
      VALUES (parent.client_id, parent.beautician_id, visit.id, parent.id, covered,
        (p_starts_at AT TIME ZONE 'UTC')::date, p_starts_at, now(), true, 'pending');
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'patch_evidence_not_saved'; END IF;
  RETURN QUERY SELECT visit.id, visit.starts_at, visit.ends_at, false;
END $$;
REVOKE ALL ON FUNCTION public.book_managed_patch_test(uuid, uuid, timestamptz, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.book_managed_patch_test(uuid, uuid, timestamptz, boolean) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
