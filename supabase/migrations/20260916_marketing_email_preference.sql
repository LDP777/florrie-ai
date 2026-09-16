-- The production schema can have email_sends without this preference.
-- Keep optional owner emails off until the owner explicitly enables them.
-- Do not replay skipped sends or change any existing true/false preference.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.beauticians
  ADD COLUMN IF NOT EXISTS marketing_emails_enabled BOOLEAN NOT NULL DEFAULT false;

-- Also repair installations that ran 022's nullable/default-true definition.
ALTER TABLE public.beauticians
  ALTER COLUMN marketing_emails_enabled SET DEFAULT false;
UPDATE public.beauticians
  SET marketing_emails_enabled = false
  WHERE marketing_emails_enabled IS NULL;
ALTER TABLE public.beauticians
  ALTER COLUMN marketing_emails_enabled SET NOT NULL;

-- Account protection grants only columns present when that migration runs.
-- Existing owner RLS and the protected-field trigger still scope this update.
GRANT UPDATE (marketing_emails_enabled) ON public.beauticians TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
