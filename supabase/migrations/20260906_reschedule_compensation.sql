-- Additive, service-only durable charge/move recovery. Apply before code.
BEGIN;
CREATE TABLE public.reschedule_payment_operations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 appointment_id uuid REFERENCES public.appointments(id) ON DELETE SET NULL,
 beautician_id uuid NOT NULL, client_id uuid,
 old_starts_at timestamptz NOT NULL, old_ends_at timestamptz NOT NULL,
 new_starts_at timestamptz NOT NULL, new_ends_at timestamptz NOT NULL,
 amount_cents integer NOT NULL CHECK (amount_cents >= 30),
 payment_intent_id text UNIQUE, payment_method_id text,
 status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','complete','refund_pending','refunded','failed')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 last_error text
);
-- Terminal financial evidence survives account deletion without retaining the
-- appointment. Active recovery must never lose its booking reference or row.
CREATE FUNCTION public.protect_reschedule_recovery() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF OLD.status IN ('pending','refund_pending') THEN
   IF TG_OP='DELETE' THEN RAISE EXCEPTION 'reschedule_payment_recovery_pending'; END IF;
   IF NEW.appointment_id IS DISTINCT FROM OLD.appointment_id THEN
     RAISE EXCEPTION 'reschedule_payment_recovery_pending';
   END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.protect_reschedule_recovery() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER reschedule_recovery_reference_guard
 BEFORE DELETE OR UPDATE OF appointment_id ON public.reschedule_payment_operations
 FOR EACH ROW EXECUTE FUNCTION public.protect_reschedule_recovery();

CREATE UNIQUE INDEX reschedule_one_active_payment ON public.reschedule_payment_operations(appointment_id)
 WHERE status IN ('pending','refund_pending');
CREATE INDEX reschedule_pending_recovery ON public.reschedule_payment_operations(updated_at)
 WHERE status IN ('pending','refund_pending');
ALTER TABLE public.reschedule_payment_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.reschedule_payment_operations FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.reschedule_payment_operations TO service_role;

CREATE FUNCTION public.prepare_reschedule_payment(p_appointment uuid, p_old_start timestamptz, p_new_start timestamptz, p_new_end timestamptz, p_expected_client uuid, p_expected_beautician uuid, p_expected_payment_method text, p_expected_amount integer)
RETURNS SETOF public.reschedule_payment_operations LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a public.appointments%ROWTYPE; o public.reschedule_payment_operations%ROWTYPE;
BEGIN
 SELECT * INTO a FROM public.appointments WHERE id=p_appointment FOR UPDATE;
 IF NOT FOUND OR a.starts_at IS DISTINCT FROM p_old_start OR a.status NOT IN ('confirmed','pending')
   OR a.client_id IS DISTINCT FROM p_expected_client OR a.beautician_id IS DISTINCT FROM p_expected_beautician
   OR a.stripe_payment_method_id IS DISTINCT FROM p_expected_payment_method OR a.deposit_cents IS DISTINCT FROM p_expected_amount
   OR p_new_start <= now() OR p_new_end <= p_new_start THEN RAISE EXCEPTION 'booking changed'; END IF;
 INSERT INTO public.reschedule_payment_operations(appointment_id,beautician_id,client_id,old_starts_at,old_ends_at,new_starts_at,new_ends_at,amount_cents)
 VALUES(a.id,a.beautician_id,a.client_id,a.starts_at,a.ends_at,p_new_start,p_new_end,a.deposit_cents) RETURNING * INTO o;
 RETURN NEXT o;
END $$;

-- Shared receipt writer runs inside the operation transaction, with the private
-- PaymentIntent key registry as the final guard against redirect/webhook concurrency.
CREATE FUNCTION public.record_reschedule_receipt(p_operation uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o public.reschedule_payment_operations%ROWTYPE;
BEGIN
 SELECT * INTO STRICT o FROM public.reschedule_payment_operations WHERE id=p_operation FOR UPDATE;
 IF o.payment_intent_id IS NULL THEN RAISE EXCEPTION 'payment identity missing'; END IF;
 BEGIN
  INSERT INTO public.transactions(beautician_id,appointment_id,client_id,amount_cents,type,status,stripe_payment_intent_id,payment_method)
  VALUES(o.beautician_id,o.appointment_id,o.client_id,o.amount_cents,'deposit','completed',o.payment_intent_id,'card_online');
 EXCEPTION WHEN unique_violation THEN NULL; -- Verify the conflicting receipt below.
 END;
 IF NOT EXISTS (SELECT 1 FROM public.transactions WHERE stripe_payment_intent_id=o.payment_intent_id
   AND beautician_id=o.beautician_id AND appointment_id=o.appointment_id AND client_id IS NOT DISTINCT FROM o.client_id
   AND amount_cents=o.amount_cents AND type='deposit')
 OR EXISTS (SELECT 1 FROM public.transactions WHERE stripe_payment_intent_id=o.payment_intent_id
 AND type IN ('deposit','full_payment','payment_link','payment','no_show_fee','late_cancel_fee')
 AND (beautician_id IS DISTINCT FROM o.beautician_id OR appointment_id IS DISTINCT FROM o.appointment_id
 OR client_id IS DISTINCT FROM o.client_id OR amount_cents IS DISTINCT FROM o.amount_cents OR type <> 'deposit'))
 THEN RAISE EXCEPTION 'payment receipt mismatch'; END IF;
END $$;

CREATE FUNCTION public.finish_paid_reschedule(p_operation uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o public.reschedule_payment_operations%ROWTYPE;
BEGIN
 SELECT * INTO STRICT o FROM public.reschedule_payment_operations WHERE id=p_operation FOR UPDATE;
 IF o.status='complete' THEN RETURN true; END IF;
 IF o.status <> 'pending' OR o.payment_intent_id IS NULL THEN RETURN false; END IF;
 UPDATE public.appointments SET starts_at=o.new_starts_at, ends_at=o.new_ends_at,
   late_reschedule_charged=true,rescheduled_at=now(),rescheduled_from=o.old_starts_at,
   deposit_paid=true,deposit_status='paid',stripe_payment_method_id=o.payment_method_id
 WHERE id=o.appointment_id AND beautician_id=o.beautician_id AND client_id IS NOT DISTINCT FROM o.client_id
   AND deposit_cents=o.amount_cents AND starts_at=o.old_starts_at AND ends_at=o.old_ends_at
   AND status IN ('confirmed','pending');
 IF NOT FOUND THEN RAISE EXCEPTION 'booking changed before move'; END IF;
 PERFORM public.record_reschedule_receipt(o.id);
 UPDATE public.reschedule_payment_operations SET status='complete',updated_at=now(),last_error=null WHERE id=o.id;
 RETURN true;
END $$;

-- This lock arbitrates a late request versus the recovery worker. Once refund
-- recovery starts, the appointment can never be moved by this operation.
CREATE FUNCTION public.claim_reschedule_refund(p_operation uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o public.reschedule_payment_operations%ROWTYPE;
BEGIN
 SELECT * INTO STRICT o FROM public.reschedule_payment_operations WHERE id=p_operation FOR UPDATE;
 IF o.status IN ('complete','refunded','failed') THEN RETURN false; END IF;
 UPDATE public.reschedule_payment_operations SET status='refund_pending',updated_at=now() WHERE id=o.id;
 RETURN true;
END $$;

CREATE FUNCTION public.finish_reschedule_refund(p_operation uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o public.reschedule_payment_operations%ROWTYPE;
BEGIN
 SELECT * INTO STRICT o FROM public.reschedule_payment_operations WHERE id=p_operation FOR UPDATE;
 IF o.status='refunded' THEN RETURN; END IF;
 IF o.status <> 'refund_pending' THEN RAISE EXCEPTION 'refund not claimed'; END IF;
 PERFORM public.record_reschedule_receipt(o.id);
 INSERT INTO public.transactions(beautician_id,appointment_id,client_id,amount_cents,type,status,stripe_payment_intent_id,payment_method,description)
 VALUES(o.beautician_id,o.appointment_id,o.client_id,-o.amount_cents,'refund','completed',o.payment_intent_id,'card_online','Reschedule not moved; deposit returned');
 UPDATE public.reschedule_payment_operations SET status='refunded',updated_at=now(),last_error=null WHERE id=o.id;
END $$;
REVOKE ALL ON FUNCTION public.prepare_reschedule_payment(uuid,timestamptz,timestamptz,timestamptz,uuid,uuid,text,integer), public.record_reschedule_receipt(uuid),public.finish_paid_reschedule(uuid),public.claim_reschedule_refund(uuid),public.finish_reschedule_refund(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_reschedule_payment(uuid,timestamptz,timestamptz,timestamptz,uuid,uuid,text,integer), public.record_reschedule_receipt(uuid),public.finish_paid_reschedule(uuid),public.claim_reschedule_refund(uuid),public.finish_reschedule_refund(uuid) TO service_role;
COMMIT;
