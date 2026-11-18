BEGIN;

-- Preserve the original completion record when its owner records a receipt.
CREATE TABLE IF NOT EXISTS public.money_receipt_confirmations (
  transaction_id uuid PRIMARY KEY REFERENCES public.transactions(id) ON DELETE CASCADE,
  beautician_id uuid NOT NULL REFERENCES public.beauticians(id) ON DELETE CASCADE,
  original_transaction jsonb NOT NULL,
  payment_method text NOT NULL CHECK (payment_method IN ('cash', 'bank_transfer', 'card_terminal')),
  received_on date NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  recorded_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.money_receipt_confirmations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.money_receipt_confirmations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.money_receipt_confirmations TO service_role;

CREATE OR REPLACE FUNCTION public.confirm_offline_receipt(
  p_owner uuid, p_transaction uuid, p_method text, p_received_on date, p_expected_cents integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE
  tx public.transactions%ROWTYPE;
  appt public.appointments%ROWTYPE;
  confirmation public.money_receipt_confirmations%ROWTYPE;
  owner_tz text;
  paid_at timestamptz;
  year_start integer;
BEGIN
  SELECT coalesce(timezone, 'Europe/London') INTO owner_tz FROM public.beauticians WHERE id = p_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'Receipt not found' USING ERRCODE = 'P0002'; END IF;
  IF p_method IS NULL OR p_method NOT IN ('cash', 'bank_transfer', 'card_terminal') OR
     p_received_on IS NULL OR p_received_on < DATE '2000-01-01' OR
     p_received_on > (now() AT TIME ZONE owner_tz)::date OR
     p_expected_cents IS NULL OR p_expected_cents <= 0 THEN
    RAISE EXCEPTION 'Choose a payment method and a valid received date' USING ERRCODE = '22023';
  END IF;

  -- Lock the booking first; transaction FKs also prevent it disappearing.
  SELECT a.* INTO appt FROM public.appointments a JOIN public.transactions t ON t.appointment_id = a.id
    WHERE t.id = p_transaction AND t.beautician_id = p_owner AND a.beautician_id = p_owner FOR UPDATE OF a;
  IF NOT FOUND THEN RAISE EXCEPTION 'Receipt not found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO tx FROM public.transactions WHERE id = p_transaction AND beautician_id = p_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Receipt not found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO confirmation FROM public.money_receipt_confirmations WHERE transaction_id = tx.id;
  IF FOUND THEN
    IF confirmation.beautician_id = p_owner AND confirmation.payment_method = p_method AND
       confirmation.received_on = p_received_on AND confirmation.amount_cents = p_expected_cents AND
       tx.payment_method = p_method AND tx.amount_cents = p_expected_cents AND tx.status = 'completed' THEN
      RETURN to_jsonb(tx);
    END IF;
    RAISE EXCEPTION 'This receipt has already been recorded. Refresh your payments.' USING ERRCODE = 'P0001';
  END IF;
  IF tx.type IS DISTINCT FROM 'payment' OR tx.status IS DISTINCT FROM 'completed' OR tx.payment_method IS NOT NULL OR
     tx.stripe_payment_intent_id IS NOT NULL OR tx.stripe_charge_id IS NOT NULL OR tx.accounting_synced IS TRUE OR
     tx.amount_cents IS DISTINCT FROM p_expected_cents OR appt.status IS DISTINCT FROM 'completed' OR appt.payment_type = 'full' THEN
    RAISE EXCEPTION 'This payment has changed. Check the appointment before recording it.' USING ERRCODE = 'P0001';
  END IF;
  IF p_expected_cents <> greatest(0, coalesce(appt.price_cents, 0) - CASE WHEN appt.deposit_paid THEN coalesce(appt.deposit_cents, 0) ELSE 0 END) OR
     EXISTS (SELECT 1 FROM public.transactions t WHERE t.appointment_id = appt.id AND t.id <> tx.id
       AND t.type IN ('payment', 'full_payment', 'payment_link', 'refund') AND t.status <> 'failed') THEN
    RAISE EXCEPTION 'Other payment records need checking. Open the appointment before recording this receipt.' USING ERRCODE = 'P0001';
  END IF;
  paid_at := least(now(), (p_received_on + TIME '12:00') AT TIME ZONE owner_tz);
  year_start := extract(year FROM p_received_on)::integer - CASE WHEN to_char(p_received_on, 'MM-DD') < '04-06' THEN 1 ELSE 0 END;
  INSERT INTO public.money_receipt_confirmations(transaction_id, beautician_id, original_transaction, payment_method, received_on, amount_cents)
    VALUES(tx.id, p_owner, to_jsonb(tx), p_method, p_received_on, p_expected_cents);
  UPDATE public.transactions SET payment_method = p_method, created_at = paid_at,
    tax_year = year_start::text || '-' || right((year_start + 1)::text, 2)
    WHERE id = tx.id RETURNING * INTO tx;
  RETURN to_jsonb(tx);
END;
$$;
REVOKE ALL ON FUNCTION public.confirm_offline_receipt(uuid,uuid,text,date,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_offline_receipt(uuid,uuid,text,date,integer) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
