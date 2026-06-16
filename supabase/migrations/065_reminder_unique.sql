-- 065_reminder_unique.sql
-- Make "one 24h reminder per appointment, ever" a hard database guarantee.
--
-- notifications.notifyReminder24h now inserts the ai_actions marker FIRST and
-- treats a unique-violation (23505) as "already reminded". This partial unique
-- index is what makes that insert-first dedupe atomic and race-proof: two
-- overlapping reminder runs can no longer both insert a marker for the same
-- appointment.
--
-- The partial WHERE scopes the constraint to reminder markers only, so every
-- other action_type (and any rows with a null appointment_id) is unaffected.

create unique index if not exists ai_actions_one_reminder_per_appt
  on public.ai_actions (appointment_id)
  where action_type = 'appointment_reminder';
