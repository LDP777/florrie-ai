-- 051_fix_ai_actions_constraints.sql
-- Audit 2026-05-29 (C1, C2, M10, H12).
--
-- Problem: ai_actions inserts were silently failing (23514 CHECK violations,
-- swallowed by try/catch) for predictive_nudge, value_coaching,
-- booking_auto_cancelled, referral_rewarded, rebook_nudge, gap_post and the
-- dynamically generated gap_fill_${matchType} types. The activity feed never
-- showed any of them.
--
-- action_type is partly generated at runtime (gap_fill_waitlist /
-- gap_fill_rebook / gap_fill_dormant), so an allow-list CHECK is structurally
-- unmaintainable. We drop it and keep NOT NULL. digital_employee is a genuinely
-- fixed enum, so we keep the guard and extend it with marketing + general.
--
-- Also fixes the whatsapp_diagnostics RLS policy: it compared beautician_id
-- (the PK) against auth.uid(), so frontend reads returned zero rows.

BEGIN;

-- 1. action_type: drop the over-strict allow-list (values are partly dynamic).
ALTER TABLE ai_actions DROP CONSTRAINT IF EXISTS ai_actions_action_type_check;

-- 2. digital_employee: keep the guard, extend with marketing + general.
ALTER TABLE ai_actions DROP CONSTRAINT IF EXISTS ai_actions_digital_employee_check;
ALTER TABLE ai_actions ADD CONSTRAINT ai_actions_digital_employee_check
  CHECK (digital_employee IN (
    'front_desk', 'calendar', 'comeback', 'content', 'money', 'scout',
    'marketing', 'general'
  ));

-- 3. whatsapp_diagnostics RLS: link via auth_id, matching every other policy.
DROP POLICY IF EXISTS "beauticians_own_whatsapp_diagnostics" ON whatsapp_diagnostics;
CREATE POLICY "beauticians_own_whatsapp_diagnostics"
  ON whatsapp_diagnostics
  FOR SELECT
  USING (
    beautician_id IN (SELECT id FROM beauticians WHERE auth_id = auth.uid())
  );

COMMIT;
