BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

-- Explicit owner-requested, draft-only work. No client, payment or publishing triggers.
CREATE TABLE IF NOT EXISTS public.content_team_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  beautician_id uuid NOT NULL REFERENCES public.beauticians(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','ready','failed')),
  brief jsonb NOT NULL CHECK (jsonb_typeof(brief)='object'),
  stages jsonb NOT NULL CHECK (jsonb_typeof(stages)='array' AND jsonb_array_length(stages)=3),
  source_snapshot jsonb,
  source_fingerprint text,
  source_checked_at timestamptz,
  lease_token uuid,
  lease_expires_at timestamptz,
  error text,
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(beautician_id,request_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS content_team_one_active_owner
  ON public.content_team_runs(beautician_id) WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS content_team_owner_history ON public.content_team_runs(beautician_id,created_at DESC);
CREATE INDEX IF NOT EXISTS content_team_work_queue ON public.content_team_runs(status,lease_expires_at,created_at) WHERE status IN ('queued','running');
ALTER TABLE public.content_team_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.content_team_runs FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.content_team_runs TO service_role;
COMMENT ON TABLE public.content_team_runs IS 'Owner-requested draft plans, captions and filming scripts. Contains no publishing authorisation.';
NOTIFY pgrst, 'reload schema';
COMMIT;
