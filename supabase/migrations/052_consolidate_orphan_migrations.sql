-- 052_consolidate_orphan_migrations.sql
-- Audit 2026-05-29 (C6, C7).
--
-- Merges the genuinely-missing tables/columns from the orphaned
-- /backend/supabase/migrations/ directory into the canonical migration
-- sequence, then that orphan directory is deleted from the repo.
--
-- Deliberately EXCLUDED from the merge:
--   * whatsapp_diagnostics  - the orphan version had phone NOT NULL, which
--     conflicts with canonical 045 (nullable). 045 wins.
--   * whatsapp_retry_* / pending_activation columns - already in 045.
--   * follow_up_enrollments - its FK target follow_up_sequences is not created
--     by ANY migration, so creating it here would fail. The follow-up-sequence
--     feature needs its own migration defining both tables before it can ship.
--
-- RLS note: the orphan policies compared beautician_id (the PK) to auth.uid().
-- That is the same bug fixed in H12 - it returns zero rows for frontend reads.
-- Rewritten here to the canonical auth_id subquery. Policies are wrapped in
-- DROP ... IF EXISTS so this file is safe to re-run.

BEGIN;

-- 1. Aftercare send tracking (prevents duplicate sends)
CREATE TABLE IF NOT EXISTS aftercare_sends (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  aftercare_message_id UUID NOT NULL REFERENCES aftercare_messages(id) ON DELETE CASCADE,
  appointment_id UUID NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(aftercare_message_id, appointment_id)
);
CREATE INDEX IF NOT EXISTS idx_aftercare_sends_lookup
  ON aftercare_sends(aftercare_message_id, appointment_id);
ALTER TABLE aftercare_sends ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Beauticians see own aftercare sends" ON aftercare_sends;
CREATE POLICY "Beauticians see own aftercare sends" ON aftercare_sends FOR SELECT
  USING (beautician_id IN (SELECT id FROM beauticians WHERE auth_id = auth.uid()));
DROP POLICY IF EXISTS "Service role inserts aftercare sends" ON aftercare_sends;
CREATE POLICY "Service role inserts aftercare sends" ON aftercare_sends FOR INSERT WITH CHECK (true);

-- 2. Review request tracking
CREATE TABLE IF NOT EXISTS review_requests_sent (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id UUID NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(appointment_id)
);
CREATE INDEX IF NOT EXISTS idx_review_requests_appointment
  ON review_requests_sent(appointment_id);
ALTER TABLE review_requests_sent ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Beauticians see own review requests" ON review_requests_sent;
CREATE POLICY "Beauticians see own review requests" ON review_requests_sent FOR SELECT
  USING (beautician_id IN (SELECT id FROM beauticians WHERE auth_id = auth.uid()));
DROP POLICY IF EXISTS "Service role inserts review requests" ON review_requests_sent;
CREATE POLICY "Service role inserts review requests" ON review_requests_sent FOR INSERT WITH CHECK (true);

-- 3. Automation rule execution log (prevents duplicate firings)
CREATE TABLE IF NOT EXISTS automation_rule_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id UUID NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  action_type TEXT NOT NULL,
  fired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(rule_id, target_id)
);
CREATE INDEX IF NOT EXISTS idx_automation_rule_logs_lookup
  ON automation_rule_logs(rule_id, target_id);
ALTER TABLE automation_rule_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Beauticians see own rule logs" ON automation_rule_logs;
CREATE POLICY "Beauticians see own rule logs" ON automation_rule_logs FOR SELECT
  USING (beautician_id IN (SELECT id FROM beauticians WHERE auth_id = auth.uid()));
DROP POLICY IF EXISTS "Service role inserts rule logs" ON automation_rule_logs;
CREATE POLICY "Service role inserts rule logs" ON automation_rule_logs FOR INSERT WITH CHECK (true);

-- 4. Booking suggestions (suggest-and-confirm from AI Front Desk / Voice) - C7
CREATE TABLE IF NOT EXISTS booking_suggestions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  client_id UUID REFERENCES clients(id) ON DELETE SET NULL,
  treatment_name TEXT NOT NULL,
  suggested_date DATE,
  suggested_time TIME,
  source TEXT NOT NULL DEFAULT 'ai_front_desk',
  message_id UUID,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'dismissed')),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_booking_suggestions_pending
  ON booking_suggestions(beautician_id, status) WHERE status = 'pending';
ALTER TABLE booking_suggestions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Beauticians see own booking suggestions" ON booking_suggestions;
CREATE POLICY "Beauticians see own booking suggestions" ON booking_suggestions FOR SELECT
  USING (beautician_id IN (SELECT id FROM beauticians WHERE auth_id = auth.uid()));
DROP POLICY IF EXISTS "Beauticians update own booking suggestions" ON booking_suggestions;
CREATE POLICY "Beauticians update own booking suggestions" ON booking_suggestions FOR UPDATE
  USING (beautician_id IN (SELECT id FROM beauticians WHERE auth_id = auth.uid()));
DROP POLICY IF EXISTS "Service role inserts booking suggestions" ON booking_suggestions;
CREATE POLICY "Service role inserts booking suggestions" ON booking_suggestions FOR INSERT WITH CHECK (true);

-- 5. Beautician/client columns referenced by automations + reviews
ALTER TABLE beauticians ADD COLUMN IF NOT EXISTS google_review_link TEXT;
ALTER TABLE clients     ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}';
ALTER TABLE clients     ADD COLUMN IF NOT EXISTS date_of_birth DATE;

-- 6. Patch-test reminder settings (from orphan 20260415)
ALTER TABLE beauticians
  ADD COLUMN IF NOT EXISTS patch_test_auto_remind        BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS patch_test_remind_days_before INTEGER NOT NULL DEFAULT 7,
  ADD COLUMN IF NOT EXISTS patch_test_block_booking      BOOLEAN NOT NULL DEFAULT false;

COMMIT;
