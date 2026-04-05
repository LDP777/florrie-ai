-- Migration 033: Credit priority rules
-- Lets beauticians decide which outbound message types get their credits
-- when supply is limited. High-value messages (bookings, reminders) are
-- always protected; marketing is the first to be paused.

ALTER TABLE beauticians
  ADD COLUMN IF NOT EXISTS credit_priority_rules JSONB DEFAULT '{
    "booking_confirmation":  "always",
    "appointment_reminder":  "always",
    "payment_request":       "always",
    "cancellation":          "always",
    "patch_test":            "always",
    "consultation_form":     "always",
    "aftercare_followup":    "if_available",
    "rebook_nudge":          "if_available",
    "ai_reply":              "if_available",
    "ai_checkin":            "if_available",
    "review_request":        "pause_first",
    "marketing":             "pause_first",
    "referral":              "pause_first",
    "general":               "if_available"
  }'::jsonb;

COMMENT ON COLUMN beauticians.credit_priority_rules IS
  'Per-type credit priority: always | if_available | pause_first';
