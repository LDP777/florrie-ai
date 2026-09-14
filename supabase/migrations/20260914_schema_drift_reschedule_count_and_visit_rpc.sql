-- Adds the missing appointments.reschedule_count column and the
-- increment_client_visit RPC that were referenced in backend routes
-- but never defined in any prior migration.
--
-- Symptom: manage-booking page received null data on PostgREST select
-- because reschedule_count was in the column list but absent from the table.
-- Appointment-completion paths silently swallowed the RPC 404, leaving
-- clients.total_visits and clients.total_spend_cents permanently at 0.

-- 1. Missing column: appointments.reschedule_count
ALTER TABLE public.appointments
  ADD COLUMN IF NOT EXISTS reschedule_count INTEGER NOT NULL DEFAULT 0;

-- 2. Missing RPC: increment_client_visit
--    Atomically increments total_visits by 1 and adds p_amount to
--    total_spend_cents. Called on every appointment completion.
CREATE OR REPLACE FUNCTION public.increment_client_visit(
  p_client_id UUID,
  p_amount    INTEGER
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.clients
  SET
    total_visits      = total_visits + 1,
    total_spend_cents = total_spend_cents + COALESCE(p_amount, 0)
  WHERE id = p_client_id;
END;
$$;
