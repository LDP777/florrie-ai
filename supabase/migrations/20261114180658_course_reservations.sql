-- A place is reserved before opening Stripe, and released only after Stripe confirms expiry.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
ALTER TABLE public.courses ADD COLUMN IF NOT EXISTS reserved_places integer NOT NULL DEFAULT 0;
ALTER TABLE public.courses ADD COLUMN IF NOT EXISTS legacy_enrolled integer NOT NULL DEFAULT 0;
ALTER TABLE public.courses ALTER COLUMN max_students SET NOT NULL;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='course_capacity_range_check') THEN
  ALTER TABLE public.courses ADD CONSTRAINT course_capacity_range_check CHECK(max_students BETWEEN 1 AND 200 AND legacy_enrolled>=0 AND reserved_places>=0);
 END IF;
END $$;
ALTER TABLE public.course_enrollments ADD COLUMN IF NOT EXISTS reservation_status text;
ALTER TABLE public.course_enrollments ADD COLUMN IF NOT EXISTS request_id uuid;
ALTER TABLE public.course_enrollments ADD COLUMN IF NOT EXISTS checkout_session_id text;
ALTER TABLE public.course_enrollments ADD COLUMN IF NOT EXISTS checkout_payload jsonb;
ALTER TABLE public.course_enrollments ADD COLUMN IF NOT EXISTS checkout_expires_at timestamptz;
ALTER TABLE public.course_enrollments ADD COLUMN IF NOT EXISTS checkout_checked_at timestamptz;
ALTER TABLE public.course_enrollments ADD COLUMN IF NOT EXISTS checkout_attention_reason text;
-- Existing open sessions may still be payable. Keep their places until provider reconciliation.
UPDATE public.course_enrollments SET reservation_status = CASE
  WHEN payment_status = 'unpaid' AND stripe_payment_intent_id LIKE 'cs_%' THEN 'held' ELSE 'confirmed' END,
  checkout_session_id = CASE WHEN stripe_payment_intent_id LIKE 'cs_%' THEN stripe_payment_intent_id END
WHERE reservation_status IS NULL;
ALTER TABLE public.course_enrollments ALTER COLUMN reservation_status SET DEFAULT 'confirmed';
ALTER TABLE public.course_enrollments ALTER COLUMN reservation_status SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='course_reservation_status_check') THEN
    ALTER TABLE public.course_enrollments ADD CONSTRAINT course_reservation_status_check
      CHECK (reservation_status IN ('held','confirmed','released'));
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS course_enrollment_request_id ON public.course_enrollments(request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS course_checkout_reconcile_order ON public.course_enrollments(checkout_checked_at NULLS FIRST, id) WHERE reservation_status='held';
CREATE UNIQUE INDEX IF NOT EXISTS course_enrollment_checkout_id ON public.course_enrollments(checkout_session_id) WHERE checkout_session_id IS NOT NULL;
DROP POLICY IF EXISTS course_enrollments_public_insert ON public.course_enrollments;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES ON public.courses,public.course_enrollments FROM anon;
REVOKE TRUNCATE,TRIGGER,REFERENCES ON public.courses,public.course_enrollments FROM authenticated;
-- Retain any historical count without student rows instead of freeing unexplained places.
UPDATE public.courses c SET legacy_enrolled = greatest(c.enrolled - (
 SELECT count(*) FROM public.course_enrollments e WHERE e.course_id=c.id AND e.reservation_status='confirmed'),0)
WHERE NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='course_enrollment_capacity_guard');

CREATE OR REPLACE FUNCTION public.guard_course_enrollment_capacity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c public.courses; target uuid; occupied integer;
BEGIN
  target := CASE WHEN TG_OP='DELETE' THEN OLD.course_id ELSE NEW.course_id END;
  SELECT * INTO c FROM public.courses WHERE id=target FOR UPDATE;
  IF NOT FOUND THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Course not found' USING ERRCODE='23503';
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.reservation_status='held' THEN RAISE EXCEPTION 'Payment is still being checked. Do not remove this place yet.' USING ERRCODE='22023'; END IF;
    RETURN OLD;
  END IF;
  IF NEW.beautician_id <> c.beautician_id THEN RAISE EXCEPTION 'Course owner mismatch' USING ERRCODE='42501'; END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.course_id<>OLD.course_id OR NEW.beautician_id<>OLD.beautician_id THEN RAISE EXCEPTION 'Enrolment cannot move between courses' USING ERRCODE='22023'; END IF;
    IF auth.uid() IS NOT NULL AND (OLD.reservation_status='held' OR NEW.reservation_status='held'
       OR NEW.checkout_session_id IS DISTINCT FROM OLD.checkout_session_id
       OR NEW.checkout_payload IS DISTINCT FROM OLD.checkout_payload
       OR NEW.checkout_expires_at IS DISTINCT FROM OLD.checkout_expires_at
       OR NEW.checkout_checked_at IS DISTINCT FROM OLD.checkout_checked_at
       OR NEW.checkout_attention_reason IS DISTINCT FROM OLD.checkout_attention_reason
       OR NEW.request_id IS DISTINCT FROM OLD.request_id) THEN
      RAISE EXCEPTION 'Checkout must finish or expire before changing this place' USING ERRCODE='42501';
    END IF;
    -- Compatibility while the previous backend finishes an in-flight request.
    -- A cs_ reference is still payable; it must become a held place, not vanish.
    IF auth.uid() IS NULL AND NEW.checkout_payload IS NULL AND NEW.payment_status='unpaid'
       AND NEW.stripe_payment_intent_id LIKE 'cs_%' AND NEW.reservation_status='confirmed' THEN
      NEW.reservation_status:='held'; NEW.checkout_session_id:=NEW.stripe_payment_intent_id;
    END IF;
    IF auth.uid() IS NULL AND OLD.reservation_status='held' AND NEW.payment_status IN ('deposit_paid','paid')
       AND NEW.stripe_payment_intent_id LIKE 'pi_%' THEN NEW.reservation_status:='confirmed'; END IF;
    IF OLD.reservation_status='released' AND NEW.payment_status IN ('deposit_paid','paid') THEN NEW.reservation_status:='confirmed'; END IF;
  ELSIF auth.uid() IS NOT NULL AND (NEW.reservation_status<>'confirmed' OR NEW.request_id IS NOT NULL OR NEW.checkout_payload IS NOT NULL OR NEW.checkout_session_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Checkout reservations are server managed' USING ERRCODE='42501';
  END IF;
  IF NEW.reservation_status IN ('held','confirmed') AND (TG_OP='INSERT' OR OLD.reservation_status='released') THEN
    SELECT count(*)+c.legacy_enrolled INTO occupied FROM public.course_enrollments
      WHERE course_id=target AND reservation_status IN ('held','confirmed') AND id<>NEW.id;
    IF occupied >= c.max_students THEN RAISE EXCEPTION 'This course is fully booked' USING ERRCODE='P0001'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.refresh_course_capacity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE target uuid;
BEGIN
 target := CASE WHEN TG_OP='DELETE' THEN OLD.course_id ELSE NEW.course_id END;
 UPDATE public.courses c SET
   enrolled=legacy_enrolled+(SELECT count(*) FROM public.course_enrollments e WHERE e.course_id=c.id AND e.reservation_status='confirmed'),
   reserved_places=(SELECT count(*) FROM public.course_enrollments e WHERE e.course_id=c.id AND e.reservation_status='held')
 WHERE c.id=target;
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS course_enrollment_capacity_guard ON public.course_enrollments;
CREATE TRIGGER course_enrollment_capacity_guard BEFORE INSERT OR UPDATE OR DELETE ON public.course_enrollments FOR EACH ROW EXECUTE FUNCTION public.guard_course_enrollment_capacity();
DROP TRIGGER IF EXISTS course_enrollment_capacity_refresh ON public.course_enrollments;
CREATE TRIGGER course_enrollment_capacity_refresh AFTER INSERT OR UPDATE OR DELETE ON public.course_enrollments FOR EACH ROW EXECUTE FUNCTION public.refresh_course_capacity();
CREATE OR REPLACE FUNCTION public.guard_course_capacity_counts() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE actual integer; held integer;
BEGIN
 IF TG_OP='INSERT' THEN
   IF coalesce(NEW.legacy_enrolled,0)<>0 OR coalesce(NEW.reserved_places,0)<>0 OR coalesce(NEW.enrolled,0)<>0 THEN
     RAISE EXCEPTION 'New courses start without booked or reserved places' USING ERRCODE='22023';
   END IF;
   NEW.legacy_enrolled:=0; NEW.reserved_places:=0; NEW.enrolled:=0;
   RETURN NEW;
 END IF;
 IF auth.uid() IS NOT NULL AND NEW.legacy_enrolled IS DISTINCT FROM OLD.legacy_enrolled THEN
   RAISE EXCEPTION 'Historical places cannot be changed here' USING ERRCODE='42501';
 END IF;
 SELECT count(*) FILTER (WHERE reservation_status='confirmed'),count(*) FILTER (WHERE reservation_status='held')
 INTO actual,held FROM public.course_enrollments WHERE course_id=NEW.id;
 NEW.enrolled:=NEW.legacy_enrolled+actual; NEW.reserved_places:=held;
 IF NEW.status='cancelled' AND OLD.status IS DISTINCT FROM 'cancelled' AND held>0 THEN
   RAISE EXCEPTION 'A payment is in progress. Close new bookings and wait for that checkout to finish or expire before cancelling this date.' USING ERRCODE='22023';
 END IF;
 IF NEW.max_students IS DISTINCT FROM OLD.max_students AND NEW.max_students<NEW.enrolled+held THEN
   RAISE EXCEPTION 'Capacity cannot be below confirmed and reserved places' USING ERRCODE='22023';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS course_capacity_counts_guard ON public.courses;
CREATE TRIGGER course_capacity_counts_guard BEFORE INSERT OR UPDATE ON public.courses FOR EACH ROW EXECUTE FUNCTION public.guard_course_capacity_counts();
UPDATE public.courses SET enrolled=enrolled;
CREATE OR REPLACE FUNCTION public.protect_course_records_on_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.beauticians WHERE id=OLD.beautician_id)
    AND EXISTS(SELECT 1 FROM public.course_enrollments WHERE course_id=OLD.id AND reservation_status IN ('held','confirmed')) THEN
   RAISE EXCEPTION 'This course has confirmed or reserved places. Cancel it to preserve student and payment records.' USING ERRCODE='22023';
 END IF;
 RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS protect_course_records_delete ON public.courses;
CREATE TRIGGER protect_course_records_delete BEFORE DELETE ON public.courses FOR EACH ROW EXECUTE FUNCTION public.protect_course_records_on_delete();
REVOKE ALL ON FUNCTION public.protect_course_records_on_delete() FROM PUBLIC,anon,authenticated;


CREATE OR REPLACE FUNCTION public.reserve_course_place(p_id uuid,p_owner uuid,p_course uuid,p_name text,p_email text,p_phone text,p_notes text,p_checkout jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c public.courses; e public.course_enrollments;
BEGIN
 SELECT * INTO c FROM public.courses WHERE id=p_course AND beautician_id=p_owner FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Course not found' USING ERRCODE='P0002'; END IF;
 SELECT * INTO e FROM public.course_enrollments WHERE request_id=p_id;
 IF FOUND THEN
   IF e.course_id<>p_course OR e.beautician_id<>p_owner OR lower(trim(e.email))<>lower(trim(p_email)) OR e.name<>trim(p_name) THEN
     RAISE EXCEPTION 'Booking request changed. Please start again.' USING ERRCODE='22023';
   END IF;
   RETURN to_jsonb(e)||jsonb_build_object('newly_created',false);
 END IF;
 IF c.status<>'active' OR c.date IS NULL OR c.date<(now() AT TIME ZONE 'Europe/London')::date
    OR (c.start_time IS NOT NULL AND c.date+c.start_time <= now() AT TIME ZONE 'Europe/London') THEN
   RAISE EXCEPTION 'This training date is not open for booking' USING ERRCODE='22023';
 END IF;
 IF EXISTS(SELECT 1 FROM public.course_enrollments WHERE course_id=p_course AND lower(trim(email))=lower(trim(p_email)) AND reservation_status<>'released') THEN
   RAISE EXCEPTION 'You already have a place or a payment in progress for this date. Check your email or contact the trainer.' USING ERRCODE='23505';
 END IF;
 INSERT INTO public.course_enrollments(id,request_id,beautician_id,course_id,name,email,phone,notes,reservation_status,checkout_payload,checkout_expires_at)
 VALUES(p_id,p_id,p_owner,p_course,trim(p_name),lower(trim(p_email)),p_phone,p_notes,
   CASE WHEN p_checkout IS NULL THEN 'confirmed' ELSE 'held' END,p_checkout,
   CASE WHEN p_checkout IS NULL THEN NULL ELSE to_timestamp((p_checkout->>'expires_at')::bigint) END)
 RETURNING * INTO e;
 RETURN to_jsonb(e)||jsonb_build_object('newly_created',true);
END $$;
CREATE OR REPLACE FUNCTION public.attach_course_checkout(p_id uuid,p_session text)
RETURNS public.course_enrollments LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e public.course_enrollments; cid uuid;
BEGIN
 SELECT course_id INTO cid FROM public.course_enrollments WHERE id=p_id;
 PERFORM 1 FROM public.courses WHERE id=cid FOR UPDATE;
 SELECT * INTO e FROM public.course_enrollments WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR p_session NOT LIKE 'cs_%' OR (e.checkout_session_id IS NOT NULL AND e.checkout_session_id<>p_session) THEN RAISE EXCEPTION 'Checkout mismatch' USING ERRCODE='22023'; END IF;
 UPDATE public.course_enrollments SET checkout_session_id=p_session,
   stripe_payment_intent_id=CASE WHEN payment_status='unpaid' THEN p_session ELSE stripe_payment_intent_id END
 WHERE id=p_id RETURNING * INTO e;
 RETURN e;
END $$;
CREATE OR REPLACE FUNCTION public.settle_course_checkout(p_id uuid,p_owner uuid,p_course uuid,p_session text,p_intent text,p_amount integer,p_expired boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e public.course_enrollments; changed boolean:=false; expected integer;
BEGIN
 PERFORM 1 FROM public.courses WHERE id=p_course AND beautician_id=p_owner FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Course not found' USING ERRCODE='P0002'; END IF;
 SELECT * INTO e FROM public.course_enrollments WHERE id=p_id AND course_id=p_course AND beautician_id=p_owner FOR UPDATE;
 IF NOT FOUND OR p_session NOT LIKE 'cs_%' OR (e.checkout_session_id IS NOT NULL AND e.checkout_session_id<>p_session) THEN RAISE EXCEPTION 'Checkout mismatch' USING ERRCODE='22023'; END IF;
 IF e.checkout_session_id IS NULL AND e.checkout_payload IS NULL THEN RAISE EXCEPTION 'Missing checkout reservation' USING ERRCODE='22023'; END IF;
 IF p_expired THEN
   IF e.reservation_status='held' AND e.payment_status='unpaid' THEN
     UPDATE public.course_enrollments SET reservation_status='released',checkout_session_id=p_session WHERE id=p_id; changed:=true;
   END IF;
 ELSE
   expected:=(e.checkout_payload#>>'{line_items,0,price_data,unit_amount}')::integer;
   IF p_intent IS NULL OR p_intent NOT LIKE 'pi_%' OR p_amount<=0 OR (expected IS NOT NULL AND p_amount<>expected) THEN RAISE EXCEPTION 'Payment amount mismatch' USING ERRCODE='22023'; END IF;
   IF e.payment_status IN ('deposit_paid','paid') THEN
     IF e.stripe_payment_intent_id<>p_intent THEN RAISE EXCEPTION 'Different payment already recorded' USING ERRCODE='22023'; END IF;
   ELSE
     IF e.reservation_status<>'held' THEN RAISE EXCEPTION 'Payment needs reconciliation: reservation released' USING ERRCODE='22023'; END IF;
     UPDATE public.course_enrollments SET reservation_status='confirmed',checkout_session_id=p_session,payment_status=CASE WHEN (e.checkout_payload#>>'{metadata,course_price_cents}')::integer > 0 AND p_amount >= (e.checkout_payload#>>'{metadata,course_price_cents}')::integer THEN 'paid' ELSE 'deposit_paid' END,amount_paid_cents=p_amount,stripe_payment_intent_id=p_intent WHERE id=p_id;
     changed:=true;
   END IF;
 END IF;
 RETURN jsonb_build_object('changed',changed,'enrollment_id',p_id);
END $$;
REVOKE ALL ON FUNCTION public.reserve_course_place(uuid,uuid,uuid,text,text,text,text,jsonb), public.attach_course_checkout(uuid,text), public.settle_course_checkout(uuid,uuid,uuid,text,text,integer,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_course_place(uuid,uuid,uuid,text,text,text,text,jsonb), public.attach_course_checkout(uuid,text), public.settle_course_checkout(uuid,uuid,uuid,text,text,integer,boolean) TO service_role;
REVOKE ALL ON FUNCTION public.guard_course_enrollment_capacity(),public.refresh_course_capacity(),public.guard_course_capacity_counts() FROM PUBLIC,anon,authenticated;
-- The confirmation intent commits with the enrolment, independently of delivery.
CREATE TABLE IF NOT EXISTS public.course_enrollment_notices (
 enrollment_id uuid PRIMARY KEY REFERENCES public.course_enrollments(id) ON DELETE CASCADE,
 beautician_id uuid NOT NULL REFERENCES public.beauticians(id) ON DELETE CASCADE,
 snapshot jsonb NOT NULL,
 email_done boolean NOT NULL DEFAULT false,
 web_done boolean NOT NULL DEFAULT false,
 apns_done boolean NOT NULL DEFAULT false,
 claim_token uuid,
 lease_until timestamptz,
 attempts integer NOT NULL DEFAULT 0,
 next_attempt_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz,
 last_error text,
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.course_enrollment_notices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.course_enrollment_notices FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.course_enrollment_notices TO service_role;
CREATE INDEX IF NOT EXISTS course_notices_due ON public.course_enrollment_notices(next_attempt_at,enrollment_id) WHERE completed_at IS NULL;
CREATE OR REPLACE FUNCTION public.enqueue_course_notice() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE b jsonb; c jsonb;
BEGIN
 IF NEW.reservation_status<>'confirmed' THEN RETURN NULL; END IF;
 -- Older backend inserts unpaid before deciding whether to open Stripe. Its
 -- manual path still sends its own notice; only a proven payment queues here.
 IF NEW.request_id IS NULL AND NEW.payment_status='unpaid' THEN RETURN NULL; END IF;
 IF TG_OP='UPDATE' AND OLD.reservation_status='confirmed' THEN RETURN NULL; END IF;
 SELECT jsonb_build_object('id',id,'first_name',to_jsonb(beauticians)->'first_name','business_name',to_jsonb(beauticians)->'business_name',
 'email',to_jsonb(beauticians)->'email','phone',to_jsonb(beauticians)->'phone','booking_slug',to_jsonb(beauticians)->'booking_slug') INTO b FROM public.beauticians WHERE id=NEW.beautician_id;
 SELECT to_jsonb(courses) INTO c FROM public.courses WHERE id=NEW.course_id;
 IF NEW.checkout_payload#>>'{metadata,course_price_cents}' IS NOT NULL THEN
  c:=c||jsonb_build_object('price',(NEW.checkout_payload#>>'{metadata,course_price_cents}')::numeric/100,
    'deposit',(NEW.checkout_payload#>>'{line_items,0,price_data,unit_amount}')::numeric/100);
 END IF;
 INSERT INTO public.course_enrollment_notices(enrollment_id,beautician_id,snapshot)
 VALUES(NEW.id,NEW.beautician_id,jsonb_build_object('beautician',b,'course',c,'enrollment',jsonb_build_object('id',NEW.id,'created_at',NEW.created_at,'name',NEW.name,'email',NEW.email,'phone',NEW.phone,'notes',NEW.notes,'payment_status',NEW.payment_status,'amount_paid_cents',NEW.amount_paid_cents),
 'paid',CASE WHEN NEW.payment_status='paid' THEN 'paid' WHEN NEW.payment_status='deposit_paid' THEN 'deposit' ELSE 'unpaid' END))
 ON CONFLICT(enrollment_id) DO NOTHING;
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS course_confirmation_notice ON public.course_enrollments;
CREATE TRIGGER course_confirmation_notice AFTER INSERT OR UPDATE ON public.course_enrollments FOR EACH ROW EXECUTE FUNCTION public.enqueue_course_notice();
CREATE OR REPLACE FUNCTION public.claim_course_notice(p_id uuid,p_token uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE n public.course_enrollment_notices;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.course_enrollments WHERE id=p_id AND reservation_status='confirmed') THEN
   UPDATE public.course_enrollment_notices SET completed_at=now(),last_error='Place no longer confirmed',claim_token=NULL,lease_until=NULL WHERE enrollment_id=p_id AND completed_at IS NULL;
   RETURN NULL;
 END IF;
 IF EXISTS(SELECT 1 FROM public.course_enrollments e JOIN public.courses c ON c.id=e.course_id WHERE e.id=p_id AND c.status='cancelled') THEN
   UPDATE public.course_enrollment_notices SET completed_at=now(),last_error='Course cancelled before remaining confirmation delivery',claim_token=NULL,lease_until=NULL WHERE enrollment_id=p_id AND completed_at IS NULL;
   RETURN NULL;
 END IF;
 UPDATE public.course_enrollment_notices SET claim_token=p_token,lease_until=now()+interval '5 minutes',attempts=attempts+1
 WHERE enrollment_id=p_id AND completed_at IS NULL AND next_attempt_at<=now() AND (lease_until IS NULL OR lease_until<now()) RETURNING * INTO n;
 RETURN CASE WHEN FOUND THEN to_jsonb(n) ELSE NULL END;
END $$;
CREATE OR REPLACE FUNCTION public.mark_course_notice_channel(p_id uuid,p_token uuid,p_channel text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF p_channel NOT IN ('email','web','apns') THEN RAISE EXCEPTION 'Invalid notification channel' USING ERRCODE='22023'; END IF;
 UPDATE public.course_enrollment_notices SET email_done=email_done OR p_channel='email',web_done=web_done OR p_channel='web',apns_done=apns_done OR p_channel='apns'
 WHERE enrollment_id=p_id AND claim_token=p_token AND lease_until>now();
 IF NOT FOUND THEN RAISE EXCEPTION 'Notification claim lost' USING ERRCODE='40001'; END IF;
END $$;
CREATE OR REPLACE FUNCTION public.finish_course_notice(p_id uuid,p_token uuid,p_error text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 UPDATE public.course_enrollment_notices SET completed_at=CASE WHEN email_done AND web_done AND apns_done THEN now() ELSE NULL END,
   next_attempt_at=now()+interval '5 minutes',last_error=left(p_error,500),claim_token=NULL,lease_until=NULL
 WHERE enrollment_id=p_id AND claim_token=p_token;
 IF NOT FOUND THEN RAISE EXCEPTION 'Notification claim lost' USING ERRCODE='40001'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.enqueue_course_notice(),public.claim_course_notice(uuid,uuid),public.mark_course_notice_channel(uuid,uuid,text),public.finish_course_notice(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_course_notice(uuid,uuid),public.mark_course_notice_channel(uuid,uuid,text),public.finish_course_notice(uuid,uuid,text) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
