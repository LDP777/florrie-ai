-- New reminders only. No historic failed messages are queued by this migration.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE IF NOT EXISTS public.whatsapp_delivery_receipts (
  message_id text PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('sent', 'delivered', 'read', 'failed')),
  provider_at timestamptz NOT NULL,
  error_code text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS whatsapp_delivery_receipts_retention
  ON public.whatsapp_delivery_receipts(updated_at);

CREATE TABLE IF NOT EXISTS public.appointment_reminder_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  beautician_id uuid NOT NULL REFERENCES public.beauticians(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  appointment_id uuid NOT NULL REFERENCES public.appointments(id) ON DELETE CASCADE,
  source_key text NOT NULL,
  message_type text NOT NULL CHECK (message_type IN ('appointment_reminder', 'patch_test', 'consultation_form')),
  appointment_starts_at timestamptz NOT NULL,
  booking_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  phone text NOT NULL,
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 8000),
  state text NOT NULL DEFAULT 'preparing' CHECK (state IN (
    'preparing', 'awaiting_whatsapp', 'sms_ready', 'sending_sms',
    'whatsapp_delivered', 'sms_sent', 'sms_failed', 'sms_unknown', 'suppressed', 'attention'
  )),
  whatsapp_message_id text UNIQUE,
  sms_message_id text,
  expires_at timestamptz NOT NULL,
  claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (beautician_id, source_key)
);
CREATE INDEX IF NOT EXISTS appointment_reminder_deliveries_active
  ON public.appointment_reminder_deliveries(updated_at, id)
  WHERE state IN ('preparing', 'awaiting_whatsapp', 'sms_ready', 'sending_sms');
CREATE INDEX IF NOT EXISTS appointment_reminder_deliveries_appointment
  ON public.appointment_reminder_deliveries(appointment_id);
CREATE INDEX IF NOT EXISTS appointment_reminder_deliveries_client
  ON public.appointment_reminder_deliveries(client_id);

ALTER TABLE public.whatsapp_delivery_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.appointment_reminder_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.whatsapp_delivery_receipts, public.appointment_reminder_deliveries FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.whatsapp_delivery_receipts, public.appointment_reminder_deliveries TO service_role;

-- Save even an early receipt, before the provider POST has returned to the sender.
-- Positive delivery evidence wins over a delayed/repeated failure notification.
CREATE OR REPLACE FUNCTION public.record_whatsapp_delivery_receipt(
  p_message_id text, p_status text, p_at timestamptz, p_error_code text DEFAULT NULL
) RETURNS void LANGUAGE sql SET search_path = '' AS $$
  INSERT INTO public.whatsapp_delivery_receipts(message_id, status, provider_at, error_code)
  VALUES(p_message_id, p_status, p_at, p_error_code)
  ON CONFLICT(message_id) DO UPDATE SET
    status = CASE
      WHEN whatsapp_delivery_receipts.status = 'read' OR excluded.status = 'read' THEN 'read'
      WHEN whatsapp_delivery_receipts.status = 'delivered' OR excluded.status = 'delivered' THEN 'delivered'
      WHEN whatsapp_delivery_receipts.status = 'failed' OR excluded.status = 'failed' THEN 'failed'
      ELSE 'sent' END,
    provider_at = greatest(whatsapp_delivery_receipts.provider_at, excluded.provider_at),
    error_code = coalesce(excluded.error_code, whatsapp_delivery_receipts.error_code),
    updated_at = now();
$$;

-- The database claim, not a process-local flag, prevents duplicate SMS on
-- concurrent webhooks, duplicate receipts, restarts and multiple backends.
-- Never reclaim a send: the legacy SMS API has no proven idempotency support.
CREATE OR REPLACE FUNCTION public.claim_appointment_reminder_sms(p_id uuid)
RETURNS SETOF public.appointment_reminder_deliveries
LANGUAGE sql SET search_path = '' AS $$
  UPDATE public.appointment_reminder_deliveries d
  SET state = 'sending_sms', claimed_at = now(), updated_at = now()
  FROM public.appointments a
  WHERE d.id = p_id AND d.appointment_id = a.id
    AND d.beautician_id = a.beautician_id AND d.client_id = a.client_id
    AND d.appointment_starts_at = a.starts_at
    AND (a.status = 'confirmed' OR (a.status = 'pending' AND d.message_type <> 'appointment_reminder'))
    AND d.expires_at > now()
    AND (d.state = 'sms_ready' OR (d.state = 'awaiting_whatsapp' AND EXISTS (
      SELECT 1 FROM public.whatsapp_delivery_receipts r
      WHERE r.message_id = d.whatsapp_message_id AND r.status = 'failed'
    )))
    AND NOT EXISTS (
      SELECT 1 FROM public.whatsapp_delivery_receipts r
      WHERE r.message_id = d.whatsapp_message_id AND r.status IN ('delivered', 'read')
    )
  RETURNING d.*;
$$;

REVOKE ALL ON FUNCTION public.record_whatsapp_delivery_receipt(text,text,timestamptz,text),
  public.claim_appointment_reminder_sms(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_whatsapp_delivery_receipt(text,text,timestamptz,text),
  public.claim_appointment_reminder_sms(uuid) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
