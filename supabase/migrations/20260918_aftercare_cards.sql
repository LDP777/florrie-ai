-- Owner-only draft guidance. This store has no delivery or AI-knowledge wiring.
-- Apply this migration before releasing the care-card editor.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE IF NOT EXISTS public.aftercare_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  beautician_id uuid NOT NULL REFERENCES public.beauticians(id) ON DELETE CASCADE,
  treatment_name text NOT NULL CHECK (length(btrim(treatment_name)) > 0),
  icon text NOT NULL DEFAULT 'sparkles',
  instructions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(instructions) = 'array'),
  products jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(products) = 'array'),
  personal_note text NOT NULL DEFAULT '',
  -- Retain the old page's preference shape; these fields do not schedule work.
  send_after_hours integer NOT NULL DEFAULT 1,
  auto_send boolean NOT NULL DEFAULT false,
  rebook_nudge_days integer NOT NULL DEFAULT 28,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_aftercare_cards_owner_active
  ON public.aftercare_cards (beautician_id, created_at DESC) WHERE archived_at IS NULL;

ALTER TABLE public.aftercare_cards ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS aftercare_cards_select_owner ON public.aftercare_cards;
CREATE POLICY aftercare_cards_select_owner ON public.aftercare_cards
  FOR SELECT TO authenticated
  USING (beautician_id IN (SELECT id FROM public.beauticians WHERE auth_id = (SELECT auth.uid())));

DROP POLICY IF EXISTS aftercare_cards_insert_owner ON public.aftercare_cards;
CREATE POLICY aftercare_cards_insert_owner ON public.aftercare_cards
  FOR INSERT TO authenticated
  WITH CHECK (beautician_id IN (SELECT id FROM public.beauticians WHERE auth_id = (SELECT auth.uid())));

DROP POLICY IF EXISTS aftercare_cards_update_owner ON public.aftercare_cards;
CREATE POLICY aftercare_cards_update_owner ON public.aftercare_cards
  FOR UPDATE TO authenticated
  USING (beautician_id IN (SELECT id FROM public.beauticians WHERE auth_id = (SELECT auth.uid())))
  WITH CHECK (beautician_id IN (SELECT id FROM public.beauticians WHERE auth_id = (SELECT auth.uid())));

-- Owners archive/restore records. The application offers no destructive delete.
REVOKE ALL ON public.aftercare_cards FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.aftercare_cards TO authenticated;
GRANT ALL ON public.aftercare_cards TO service_role;

CREATE OR REPLACE FUNCTION public.set_aftercare_card_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  NEW.updated_at = pg_catalog.clock_timestamp();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS aftercare_cards_updated_at ON public.aftercare_cards;
CREATE TRIGGER aftercare_cards_updated_at BEFORE UPDATE ON public.aftercare_cards
  FOR EACH ROW EXECUTE FUNCTION public.set_aftercare_card_updated_at();

COMMENT ON TABLE public.aftercare_cards IS
  'Private saved care guidance; separate from aftercare_messages and approved knowledge_entries. Archiving retains the original guidance. No automated delivery reads this table.';

COMMIT;
