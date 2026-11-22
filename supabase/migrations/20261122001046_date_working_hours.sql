-- Dated opening hours are separate from time-off blocks. Never reinterpret or
-- migrate existing amended/extended blocks: those still remove availability.
CREATE TABLE public.date_working_hours (
  beautician_id uuid NOT NULL REFERENCES public.beauticians(id) ON DELETE CASCADE,
  date date NOT NULL,
  start_time time NOT NULL,
  end_time time NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (beautician_id, date),
  CONSTRAINT date_working_hours_order CHECK (end_time > start_time),
  CONSTRAINT date_working_hours_same_day CHECK (end_time < time '24:00:00'),
  CONSTRAINT date_working_hours_whole_minutes CHECK (extract(second FROM start_time) = 0 AND extract(second FROM end_time) = 0)
);
ALTER TABLE public.date_working_hours ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.date_working_hours FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.date_working_hours TO authenticated;
GRANT ALL ON public.date_working_hours TO service_role;
CREATE POLICY date_working_hours_owner_read ON public.date_working_hours
  FOR SELECT TO authenticated USING (
    beautician_id IN (SELECT id FROM public.beauticians WHERE auth_id = (SELECT auth.uid()))
  );
COMMENT ON TABLE public.date_working_hours IS 'Opening hours for an individual salon date. Replaces the usual weekday hours; hours_exceptions still block time inside this window. Writes through authenticated working-hours API only.';
NOTIFY pgrst, 'reload schema';
