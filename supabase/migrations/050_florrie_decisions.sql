-- ============================================================
-- 050_florrie_decisions.sql
-- Day 4 of the 2026-05-28 refactor sprint.
--
-- Every Yes / No / Tweak Ellie taps on a Florrie suggestion card
-- logs here. Used later to train the AI on what she actually wants.
-- ============================================================

CREATE TABLE IF NOT EXISTS florrie_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  suggestion_type TEXT NOT NULL,
  suggestion_payload JSONB NOT NULL DEFAULT '{}',
  response TEXT NOT NULL CHECK (response IN ('yes', 'no', 'tweak', 'dismissed')),
  tweak_payload JSONB,
  acted_on BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_florrie_decisions_bz
  ON florrie_decisions(beautician_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_florrie_decisions_type
  ON florrie_decisions(beautician_id, suggestion_type, created_at DESC);

ALTER TABLE florrie_decisions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS florrie_decisions_own ON florrie_decisions;
CREATE POLICY florrie_decisions_own ON florrie_decisions
  FOR ALL
  USING (beautician_id IN (SELECT id FROM beauticians WHERE auth_id = auth.uid()));
