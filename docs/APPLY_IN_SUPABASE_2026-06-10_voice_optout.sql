-- 055: PECR opt-out flag + voice-moat instrumentation.
--
-- 1) clients.marketing_opted_out_at: set the moment a client replies STOP on
--    any channel. The marketing guard (backend/src/lib/marketing-guard.js)
--    blocks every marketing-class send to that client forever after.
--    marketing_consent/marketing_consent_at already exist (001) and are now
--    actually captured on the public booking form.
--
-- 2) voice_metrics: one row per inbox reply that started life as a Florrie
--    draft. similarity = how close the sent text stayed to the draft;
--    untouched = sent with no meaningful edit. "% sent untouched" is the
--    voice-moat headline metric.

ALTER TABLE clients ADD COLUMN IF NOT EXISTS marketing_opted_out_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS voice_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  client_id UUID REFERENCES clients(id) ON DELETE SET NULL,
  draft_text TEXT NOT NULL,
  sent_text TEXT NOT NULL,
  similarity REAL NOT NULL,
  untouched BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE voice_metrics ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS voice_metrics_select_own ON voice_metrics;
CREATE POLICY voice_metrics_select_own ON voice_metrics
  FOR SELECT USING (
    beautician_id IN (SELECT id FROM beauticians WHERE auth_id = auth.uid())
  );
-- Writes happen via the backend service role only (bypasses RLS).

CREATE INDEX IF NOT EXISTS idx_voice_metrics_b_created
  ON voice_metrics (beautician_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_clients_marketing_opted_out
  ON clients (beautician_id) WHERE marketing_opted_out_at IS NOT NULL;
