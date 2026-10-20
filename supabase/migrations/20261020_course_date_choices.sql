-- Offered training dates remain individual courses so their students,
-- payments and capacity keep their existing meaning. The optional group
-- connects only the dates offered for the same course.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.courses ADD COLUMN IF NOT EXISTS course_group_id uuid;
ALTER TABLE public.courses ADD COLUMN IF NOT EXISTS start_time time;

CREATE INDEX IF NOT EXISTS courses_owner_group_date_idx
  ON public.courses (beautician_id, course_group_id, date);
CREATE UNIQUE INDEX IF NOT EXISTS courses_group_date_time_unique
  ON public.courses (beautician_id, course_group_id, date, COALESCE(start_time, '00:00'::time))
  WHERE course_group_id IS NOT NULL AND date IS NOT NULL;

-- A form opened before a student booked must not move that student's date
-- when it is saved later. Add a new occurrence instead.
CREATE OR REPLACE FUNCTION public.protect_booked_course_date()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF (NEW.date IS DISTINCT FROM OLD.date OR NEW.start_time IS DISTINCT FROM OLD.start_time)
     AND (COALESCE(OLD.enrolled, 0) > 0 OR EXISTS (
       SELECT 1 FROM public.course_enrollments e
       WHERE e.course_id = OLD.id AND e.beautician_id = OLD.beautician_id
     )) THEN
    -- An open checkout may still settle. Moving it would make its paid date
    -- differ from the date the student chose at checkout.
    RAISE EXCEPTION 'This date has bookings or a checkout in progress. Add another course date instead.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS protect_booked_course_date ON public.courses;
CREATE TRIGGER protect_booked_course_date BEFORE UPDATE OF date, start_time ON public.courses
  FOR EACH ROW EXECUTE FUNCTION public.protect_booked_course_date();
REVOKE ALL ON FUNCTION public.protect_booked_course_date() FROM PUBLIC, anon;

-- Adding dates to an existing singleton must not leave a half-saved group.
-- Stable client-generated ids make a lost response safe to retry.
CREATE OR REPLACE FUNCTION public.add_course_dates(p_course_id uuid, p_dates jsonb)
RETURNS SETOF public.courses
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  anchor public.courses%ROWTYPE;
  existing public.courses%ROWTYPE;
  item jsonb;
  group_id uuid;
  row_id uuid;
  day_value date;
  time_value time;
  seats integer;
  returned_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Please sign in before adding course dates' USING ERRCODE = '42501';
  END IF;
  IF p_dates IS NULL OR jsonb_typeof(p_dates) <> 'array'
     OR jsonb_array_length(p_dates) NOT BETWEEN 1 AND 24 THEN
    RAISE EXCEPTION 'Choose between 1 and 24 new course dates' USING ERRCODE = '22023';
  END IF;

  SELECT c.* INTO anchor FROM public.courses c
    JOIN public.beauticians b ON b.id = c.beautician_id
    WHERE c.id = p_course_id AND b.auth_id = auth.uid()
    FOR UPDATE OF c;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Course not found' USING ERRCODE = 'P0002';
  END IF;
  group_id := COALESCE(anchor.course_group_id, anchor.id);
  UPDATE public.courses SET course_group_id = group_id
    WHERE id = anchor.id AND course_group_id IS NULL;
  returned_ids := array_append(returned_ids, anchor.id);

  FOR item IN SELECT value FROM jsonb_array_elements(p_dates) LOOP
    IF jsonb_typeof(item) <> 'object'
       OR COALESCE(item->>'id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR COALESCE(item->>'date', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       OR COALESCE(item->>'max_students', '') !~ '^[0-9]{1,4}$' THEN
      RAISE EXCEPTION 'Each date needs an id, a valid date and student capacity' USING ERRCODE = '22023';
    END IF;
    row_id := (item->>'id')::uuid;
    day_value := (item->>'date')::date;
    seats := (item->>'max_students')::integer;
    IF seats NOT BETWEEN 1 AND 200 OR to_char(day_value, 'YYYY-MM-DD') <> item->>'date' THEN
      RAISE EXCEPTION 'Check the date and student capacity' USING ERRCODE = '22023';
    END IF;
    time_value := NULL;
    IF NULLIF(item->>'start_time', '') IS NOT NULL THEN
      IF item->>'start_time' !~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$' THEN
        RAISE EXCEPTION 'Check the course start time' USING ERRCODE = '22023';
      END IF;
      time_value := (item->>'start_time')::time;
    END IF;
    IF row_id = ANY(returned_ids) THEN
      RAISE EXCEPTION 'Each new date must have a different id' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO existing FROM public.courses WHERE id = row_id;
    IF FOUND THEN
      IF existing.beautician_id <> anchor.beautician_id
         OR existing.course_group_id IS DISTINCT FROM group_id
         OR existing.date IS DISTINCT FROM day_value
         OR existing.start_time IS DISTINCT FROM time_value
         OR existing.max_students IS DISTINCT FROM seats THEN
        RAISE EXCEPTION 'That saved date differs. Refresh your courses before trying again' USING ERRCODE = '22023';
      END IF;
      returned_ids := array_append(returned_ids, row_id);
      CONTINUE;
    END IF;

    IF day_value < (now() AT TIME ZONE 'Europe/London')::date THEN
      RAISE EXCEPTION 'New course dates cannot be in the past' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.courses (
      id, beautician_id, course_group_id, name, description, date, start_time,
      location, duration, max_students, price, deposit, includes, status,
      enrolled, booking_slug
    ) VALUES (
      row_id, anchor.beautician_id, group_id, anchor.name, anchor.description,
      day_value, time_value, anchor.location, anchor.duration, seats,
      anchor.price, anchor.deposit, anchor.includes, 'active', 0, anchor.booking_slug
    );
    returned_ids := array_append(returned_ids, row_id);
  END LOOP;
  RETURN QUERY SELECT * FROM public.courses
    WHERE id = ANY(returned_ids) AND beautician_id = anchor.beautician_id
    ORDER BY date NULLS LAST, start_time NULLS LAST, id;
END;
$$;

REVOKE ALL ON FUNCTION public.add_course_dates(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_course_dates(uuid, jsonb) TO authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;
