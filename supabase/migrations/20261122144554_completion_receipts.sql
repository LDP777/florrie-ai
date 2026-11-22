BEGIN;

-- Opt-in bookkeeping rule: completing a visit records its remaining price.
-- This never calls a payment provider or claims a cash/card/bank payment method.
ALTER TABLE public.beauticians ADD COLUMN IF NOT EXISTS completion_receipts_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE public.appointments ADD COLUMN IF NOT EXISTS completion_payment_unpaid boolean NOT NULL DEFAULT false;
ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_payment_method_check;
ALTER TABLE public.transactions ADD CONSTRAINT transactions_payment_method_check CHECK
  (payment_method IN ('card_online','card_terminal','tap_to_pay','cash','bank_transfer','completion_record','completion_unpaid'));

CREATE TABLE public.completion_receipt_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  beautician_id uuid NOT NULL REFERENCES public.beauticians(id) ON DELETE CASCADE,
  appointment_id uuid NOT NULL,
  transaction_id uuid NOT NULL,
  action text NOT NULL,
  original_transaction jsonb,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.completion_receipt_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.completion_receipt_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.completion_receipt_events TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.completion_receipt_events_id_seq TO service_role;
CREATE UNIQUE INDEX transactions_one_completion_record ON public.transactions(appointment_id)
  WHERE payment_method IN ('completion_record','completion_unpaid') AND type = 'payment';

CREATE FUNCTION public.record_completion_receipt(p_owner uuid, p_appointment uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE
  appt public.appointments%ROWTYPE;
  tx public.transactions%ROWTYPE;
  old_tx public.transactions%ROWTYPE;
  owner_tz text;
  enabled boolean;
  due_cents bigint;
  paid_deposit bigint;
  paid_balance bigint;
  receipt_at timestamptz;
  receipt_day date;
  year_start integer;
BEGIN
  SELECT completion_receipts_enabled, coalesce(timezone,'Europe/London') INTO enabled, owner_tz
    FROM public.beauticians WHERE id=p_owner;
  IF enabled IS DISTINCT FROM true THEN RETURN NULL; END IF;
  SELECT * INTO appt FROM public.appointments WHERE id=p_appointment AND beautician_id=p_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Appointment not found' USING ERRCODE='P0002'; END IF;
  IF appt.status <> 'completed' OR appt.starts_at IS NULL OR
     appt.starts_at > ((now() AT TIME ZONE owner_tz) AT TIME ZONE 'UTC') THEN RETURN NULL; END IF;
  SELECT * INTO tx FROM public.transactions WHERE appointment_id=appt.id
    AND payment_method IN ('completion_record','completion_unpaid') AND type='payment' FOR UPDATE;
  IF FOUND THEN RETURN to_jsonb(tx); END IF;

  -- Count each successful provider receipt once. Refunds stay separate; a
  -- refund must never cause the same payment to be generated again.
  IF EXISTS (SELECT 1 FROM public.transactions WHERE appointment_id=appt.id AND
    type IN ('deposit','payment','full_payment','payment_link') AND status='pending' AND stripe_payment_intent_id IS NOT NULL)
    THEN RETURN NULL; END IF;
  SELECT coalesce(sum(amount_cents) FILTER (WHERE type='deposit'),0),
         coalesce(sum(amount_cents) FILTER (WHERE type<>'deposit'),0)
    INTO paid_deposit,paid_balance FROM (
      SELECT DISTINCT ON (coalesce(stripe_payment_intent_id,id::text)) type,amount_cents
      FROM public.transactions WHERE appointment_id=appt.id AND beautician_id=p_owner AND status='completed'
        AND type IN ('deposit','payment','full_payment','payment_link') AND amount_cents>0
        AND (payment_method IS NOT NULL OR stripe_payment_intent_id IS NOT NULL)
        AND coalesce(payment_method,'') NOT IN ('completion_record','completion_unpaid')
      ORDER BY coalesce(stripe_payment_intent_id,id::text),created_at,id
    ) actual;
  due_cents := greatest(0, coalesce(appt.price_cents,0)
    + coalesce((SELECT sum(price_cents) FROM public.appointment_add_ons WHERE appointment_id=appt.id),0)
    - coalesce(appt.discount_cents,0)
    - greatest(paid_deposit,CASE WHEN appt.deposit_paid THEN coalesce(appt.deposit_cents,0) ELSE 0 END)
    - paid_balance);
  IF appt.package_redemption IS TRUE THEN due_cents := 0; END IF;
  -- A full-payment booking without its provider receipt is for reconciliation,
  -- not an extra receipt on completion.
  IF appt.payment_type='full' AND paid_balance=0 THEN RETURN NULL; END IF;
  receipt_at := least(now(), (coalesce(appt.ends_at,appt.starts_at) AT TIME ZONE 'UTC') AT TIME ZONE owner_tz);
  receipt_day := (receipt_at AT TIME ZONE owner_tz)::date;
  year_start := extract(year FROM receipt_day)::integer - CASE WHEN to_char(receipt_day,'MM-DD')<'04-06' THEN 1 ELSE 0 END;

  -- Preserve the original record before converting it. Surplus legacy guesses
  -- are removed only after retaining their audit copy; actual receipts survive.
  FOR old_tx IN SELECT * FROM public.transactions WHERE appointment_id=appt.id AND beautician_id=p_owner
    AND type='payment' AND status='completed' AND payment_method IS NULL
    AND stripe_payment_intent_id IS NULL AND stripe_charge_id IS NULL AND accounting_synced IS NOT TRUE
    ORDER BY created_at,id FOR UPDATE
  LOOP
    INSERT INTO public.completion_receipt_events(beautician_id,appointment_id,transaction_id,action,original_transaction)
      VALUES(p_owner,appt.id,old_tx.id,CASE WHEN due_cents>0 AND tx.id IS NULL THEN 'confirmed_on_completion' ELSE 'superseded' END,to_jsonb(old_tx));
    IF due_cents>0 AND tx.id IS NULL THEN
      UPDATE public.transactions SET payment_method=CASE WHEN appt.completion_payment_unpaid THEN 'completion_unpaid' ELSE 'completion_record' END,
        status=CASE WHEN appt.completion_payment_unpaid THEN 'pending' ELSE 'completed' END,amount_cents=due_cents::integer,
        created_at=receipt_at,tax_year=year_start::text||'-'||right((year_start+1)::text,2)
        WHERE id=old_tx.id RETURNING * INTO tx;
    ELSE DELETE FROM public.transactions WHERE id=old_tx.id;
    END IF;
  END LOOP;
  IF due_cents>0 AND tx.id IS NULL THEN
    INSERT INTO public.transactions(beautician_id,appointment_id,client_id,amount_cents,type,status,payment_method,created_at,tax_year,description)
      VALUES(p_owner,appt.id,appt.client_id,due_cents::integer,'payment',CASE WHEN appt.completion_payment_unpaid THEN 'pending' ELSE 'completed' END,
        CASE WHEN appt.completion_payment_unpaid THEN 'completion_unpaid' ELSE 'completion_record' END,receipt_at,
        year_start::text||'-'||right((year_start+1)::text,2),'Recorded on completion') RETURNING * INTO tx;
    INSERT INTO public.completion_receipt_events(beautician_id,appointment_id,transaction_id,action)
      VALUES(p_owner,appt.id,tx.id,'recorded_on_completion');
  END IF;
  RETURN CASE WHEN tx.id IS NULL THEN NULL ELSE to_jsonb(tx) END;
END;
$$;

CREATE FUNCTION public.completion_receipt_status_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE old_tx public.transactions%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  IF NEW.status='completed' THEN
    PERFORM public.record_completion_receipt(NEW.beautician_id,NEW.id);
  ELSE
    FOR old_tx IN SELECT * FROM public.transactions WHERE appointment_id=NEW.id AND beautician_id=NEW.beautician_id
      AND payment_method IN ('completion_record','completion_unpaid') AND stripe_payment_intent_id IS NULL AND stripe_charge_id IS NULL FOR UPDATE
    LOOP
      INSERT INTO public.completion_receipt_events(beautician_id,appointment_id,transaction_id,action,original_transaction)
        VALUES(NEW.beautician_id,NEW.id,old_tx.id,'appointment_'||NEW.status,to_jsonb(old_tx));
      DELETE FROM public.transactions WHERE id=old_tx.id;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER completion_receipt_status_changed AFTER INSERT OR UPDATE OF status ON public.appointments
  FOR EACH ROW EXECUTE FUNCTION public.completion_receipt_status_changed();

-- Older completion code may still try to insert the same null-method row.
-- Route it through the locked recorder instead of double-counting the visit.
CREATE FUNCTION public.route_completion_receipt_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.type='payment' AND NEW.status='completed' AND NEW.payment_method IS NULL AND NEW.stripe_payment_intent_id IS NULL
    AND NEW.stripe_charge_id IS NULL AND EXISTS (SELECT 1 FROM public.beauticians WHERE id=NEW.beautician_id AND completion_receipts_enabled)
    AND EXISTS (SELECT 1 FROM public.appointments WHERE id=NEW.appointment_id AND beautician_id=NEW.beautician_id AND status='completed') THEN
      PERFORM public.record_completion_receipt(NEW.beautician_id,NEW.appointment_id);
      RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER route_completion_receipt_insert BEFORE INSERT ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public.route_completion_receipt_insert();

CREATE FUNCTION public.set_completion_receipt_paid(p_owner uuid,p_transaction uuid,p_paid boolean,p_expected_cents integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE appt public.appointments%ROWTYPE; tx public.transactions%ROWTYPE;
BEGIN
  SELECT a.* INTO appt FROM public.appointments a JOIN public.transactions t ON t.appointment_id=a.id
    WHERE t.id=p_transaction AND t.beautician_id=p_owner AND a.beautician_id=p_owner FOR UPDATE OF a;
  IF NOT FOUND THEN RAISE EXCEPTION 'Receipt not found' USING ERRCODE='P0002'; END IF;
  SELECT * INTO tx FROM public.transactions WHERE id=p_transaction AND beautician_id=p_owner FOR UPDATE;
  IF p_paid IS NULL OR p_expected_cents IS NULL OR p_expected_cents<=0 THEN RAISE EXCEPTION 'Invalid payment choice' USING ERRCODE='22023'; END IF;
  IF appt.status<>'completed' OR tx.type<>'payment' OR tx.payment_method NOT IN ('completion_record','completion_unpaid')
    OR tx.payment_method IS NULL OR tx.stripe_payment_intent_id IS NOT NULL OR tx.stripe_charge_id IS NOT NULL
    OR tx.accounting_synced IS TRUE OR tx.amount_cents<>p_expected_cents THEN
    RAISE EXCEPTION 'Payment has changed. Refresh your records.' USING ERRCODE='P0001';
  END IF;
  IF (p_paid AND tx.payment_method='completion_record') OR (NOT p_paid AND tx.payment_method='completion_unpaid') THEN RETURN to_jsonb(tx); END IF;
  INSERT INTO public.completion_receipt_events(beautician_id,appointment_id,transaction_id,action,original_transaction)
    VALUES(p_owner,appt.id,tx.id,CASE WHEN p_paid THEN 'marked_paid' ELSE 'marked_unpaid' END,to_jsonb(tx));
  UPDATE public.appointments SET completion_payment_unpaid=NOT p_paid WHERE id=appt.id;
  UPDATE public.transactions SET payment_method=CASE WHEN p_paid THEN 'completion_record' ELSE 'completion_unpaid' END,
    status=CASE WHEN p_paid THEN 'completed' ELSE 'pending' END WHERE id=tx.id RETURNING * INTO tx;
  RETURN to_jsonb(tx);
END;
$$;
REVOKE ALL ON FUNCTION public.record_completion_receipt(uuid,uuid),public.completion_receipt_status_changed(),
  public.route_completion_receipt_insert(),public.set_completion_receipt_paid(uuid,uuid,boolean,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_completion_receipt(uuid,uuid),public.completion_receipt_status_changed(),
  public.route_completion_receipt_insert(),public.set_completion_receipt_paid(uuid,uuid,boolean,integer) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
