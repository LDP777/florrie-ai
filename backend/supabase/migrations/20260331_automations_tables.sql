-- ============================================================================
-- Automations tables — supports aftercare, rebook, review requests,
-- automation rules engine, follow-up sequences, and booking suggestions
-- ============================================================================

-- 1. Aftercare send tracking (prevents duplicate sends)
CREATE TABLE IF NOT EXISTS aftercare_sends (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  aftercare_message_id UUID NOT NULL REFERENCES aftercare_messages(id) ON DELETE CASCADE,
  appointment_id UUID NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(aftercare_message_id, appointment_id)
);

CREATE INDEX idx_aftercare_sends_lookup
  ON aftercare_sends(aftercare_message_id, appointment_id);

ALTER TABLE aftercare_sends ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Beauticians see own aftercare sends"
  ON aftercare_sends FOR SELECT
  USING (beautician_id = auth.uid());

CREATE POLICY "Service role inserts aftercare sends"
  ON aftercare_sends FOR INSERT
  WITH CHECK (true);


-- 2. Review request tracking
CREATE TABLE IF NOT EXISTS review_requests_sent (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id UUID NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(appointment_id)
);

CREATE INDEX idx_review_requests_appointment
  ON review_requests_sent(appointment_id);

ALTER TABLE review_requests_sent ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Beauticians see own review requests"
  ON review_requests_sent FOR SELECT
  USING (beautician_id = auth.uid());

CREATE POLICY "Service role inserts review requests"
  ON review_requests_sent FOR INSERT
  WITH CHECK (true);


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

CREATE INDEX idx_automation_rule_logs_lookup
  ON automation_rule_logs(rule_id, target_id);

ALTER TABLE automation_rule_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Beauticians see own rule logs"
  ON automation_rule_logs FOR SELECT
  USING (beautician_id = auth.uid());

CREATE POLICY "Service role inserts rule logs"
  ON automation_rule_logs FOR INSERT
  WITH CHECK (true);


-- 4. Follow-up sequence enrollments
CREATE TABLE IF NOT EXISTS follow_up_enrollments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id UUID NOT NULL REFERENCES follow_up_sequences(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  appointment_id UUID NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  enrolled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  current_step INTEGER NOT NULL DEFAULT 0,
  next_send_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'paused', 'cancelled')),
  UNIQUE(sequence_id, appointment_id)
);

CREATE INDEX idx_follow_up_enrollments_due
  ON follow_up_enrollments(status, next_send_at)
  WHERE status = 'active';

CREATE INDEX idx_follow_up_enrollments_sequence
  ON follow_up_enrollments(sequence_id, appointment_id);

ALTER TABLE follow_up_enrollments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Beauticians see own enrollments"
  ON follow_up_enrollments FOR SELECT
  USING (beautician_id = auth.uid());

CREATE POLICY "Service role manages enrollments"
  ON follow_up_enrollments FOR ALL
  WITH CHECK (true);


-- 5. Booking suggestions (suggest-and-confirm from AI Front Desk / Voice)
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

CREATE INDEX idx_booking_suggestions_pending
  ON booking_suggestions(beautician_id, status)
  WHERE status = 'pending';

ALTER TABLE booking_suggestions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Beauticians see own booking suggestions"
  ON booking_suggestions FOR SELECT
  USING (beautician_id = auth.uid());

CREATE POLICY "Beauticians update own booking suggestions"
  ON booking_suggestions FOR UPDATE
  USING (beautician_id = auth.uid());

CREATE POLICY "Service role inserts booking suggestions"
  ON booking_suggestions FOR INSERT
  WITH CHECK (true);


-- 6. Add google_review_link to beauticians if not already present
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'beauticians' AND column_name = 'google_review_link'
  ) THEN
    ALTER TABLE beauticians ADD COLUMN google_review_link TEXT;
  END IF;
END $$;


-- 7. Add last_visit_at to clients if not already present
-- (used by automation rules for dormant client triggers)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'clients' AND column_name = 'last_visit_at'
  ) THEN
    ALTER TABLE clients ADD COLUMN last_visit_at TIMESTAMPTZ;
  END IF;
END $$;

-- Backfill last_visit_at from appointment history
UPDATE clients c
SET last_visit_at = sub.latest
FROM (
  SELECT client_id, MAX(ends_at) AS latest
  FROM appointments
  WHERE status IN ('completed', 'confirmed')
  GROUP BY client_id
) sub
WHERE c.id = sub.client_id
  AND (c.last_visit_at IS NULL OR c.last_visit_at < sub.latest);


-- 8. Add tags column to clients if not already present
-- (used by automation rules add_tag action)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'clients' AND column_name = 'tags'
  ) THEN
    ALTER TABLE clients ADD COLUMN tags TEXT[] DEFAULT '{}';
  END IF;
END $$;


-- 9. Add date_of_birth to clients if not already present
-- (used by birthday automation trigger)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'clients' AND column_name = 'date_of_birth'
  ) THEN
    ALTER TABLE clients ADD COLUMN date_of_birth DATE;
  END IF;
END $$;
