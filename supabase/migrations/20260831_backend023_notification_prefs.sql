-- 023: beauticians.notification_prefs, which production never had.
--
-- 31 August 2026. The pilot salon owner: "there is no notification for when
-- people book now, only when they try and haven't paid deposit yet." She was
-- being told about the bookings that did NOT complete and told nothing about
-- the ones that did.
--
-- One of the reasons is this column. Migration 002 defines it, and 002 was only
-- PARTLY applied: client_reminder_prefs, written in the same ALTER block, is
-- present in production, and notification_prefs is not. So every read of it
-- came back { data: null, error } (PostgREST rejects the WHOLE select when one
-- column is unknown, and reports it by resolving rather than throwing), and
-- shouldPush in backend/src/services/push-notifications.js fell into its
-- fail-open catch on every single push. Nothing was suppressed, so nothing
-- looked broken, and the Settings toggles the owner had been setting for months
-- were decorative: saved by the frontend straight into PostgREST, which
-- rejected the write, and never read at send time because there was nothing to
-- read.
--
-- Migration 002 is NOT edited. It has already been run by hand against live
-- databases, so a change there is a change nobody applies.
--
-- THE DEFAULT IS 002'S, EXACTLY, plus one key.
--
-- The ADD COLUMN below carries 002's default verbatim, because that is what was
-- already run by hand against production on 31 August 2026 and re-running this
-- file must be a no-op there rather than a second, different default. The new
-- booking_pending key is then added separately, in two steps, so that both a
-- fresh database and the four rows already sitting in production end up with
-- the same shape.
--
-- WHY booking_pending IS A KEY AT ALL. ACTION_TO_PREF used to map BOTH
-- booking_pending and booking_confirmed to 'booking_confirmed', and Settings
-- showed one toggle labelled "New bookings" for the pair. Harmless while the
-- column did not exist and everything failed open. The moment the column is
-- live it means the owner cannot silence the "somebody is trying to book" buzz
-- without also silencing the one she is asking for, so the two moments get two
-- switches. Both default to push on: a missing key means send, and that is the
-- behaviour she has today.
--
-- Run by hand in the Supabase SQL editor (idempotent, safe to re-run).
-- After running, RESTART Railway so PgBouncer's schema cache sees the change.

-- 1. The column, with migration 002's default word for word.
ALTER TABLE beauticians ADD COLUMN IF NOT EXISTS notification_prefs JSONB DEFAULT '{
  "booking_confirmed": {"email": true, "push": true, "sms": false},
  "booking_cancelled": {"email": true, "push": true, "sms": false},
  "reminder_24h": {"email": true, "push": true, "sms": false},
  "reminder_1h": {"email": false, "push": true, "sms": false},
  "ai_escalation": {"email": true, "push": true, "sms": false},
  "weekly_digest": {"email": true, "push": false, "sms": false},
  "payment_received": {"email": true, "push": true, "sms": false},
  "new_review": {"email": true, "push": true, "sms": false}
}'::jsonb;

-- 2. Anything already in the table with no prefs at all gets the default. On a
-- database where the column has just been added every row is NULL, and a NULL
-- here is not "she turned everything off", it is "nobody ever asked her".
UPDATE beauticians SET notification_prefs = DEFAULT WHERE notification_prefs IS NULL;

-- 3. booking_pending joins the default for rows created from here on.
ALTER TABLE beauticians ALTER COLUMN notification_prefs SET DEFAULT '{
  "booking_confirmed": {"email": true, "push": true, "sms": false},
  "booking_pending": {"email": true, "push": true, "sms": false},
  "booking_cancelled": {"email": true, "push": true, "sms": false},
  "reminder_24h": {"email": true, "push": true, "sms": false},
  "reminder_1h": {"email": false, "push": true, "sms": false},
  "ai_escalation": {"email": true, "push": true, "sms": false},
  "weekly_digest": {"email": true, "push": false, "sms": false},
  "payment_received": {"email": true, "push": true, "sms": false},
  "new_review": {"email": true, "push": true, "sms": false}
}'::jsonb;

-- 4. And to the rows that already exist, without touching any other key. `||`
-- merges, so a beautician who has already turned something off keeps her
-- choice. The WHERE means re-running this cannot resurrect a booking_pending
-- she has since switched off.
UPDATE beauticians
   SET notification_prefs =
       notification_prefs || '{"booking_pending": {"email": true, "push": true, "sms": false}}'::jsonb
 WHERE notification_prefs IS NOT NULL
   AND NOT (notification_prefs ? 'booking_pending');

COMMENT ON COLUMN beauticians.notification_prefs IS
  'Per-event push/email/sms toggles the owner sets in Settings. Read at send time by shouldPush in backend/src/services/push-notifications.js, which fails OPEN: a missing key, or an unreadable column, means send. Keys must stay in step with ACTION_TO_PREF there and with the rows in frontend/src/pages/Settings.jsx. booking_pending is deliberately separate from booking_confirmed (added 31 Aug 2026, the owner reported being told only about bookings that had not been paid for): one is a booking, the other is somebody who stopped at the payment screen, and she must be able to silence either without the other. quiet_hours is OPT IN and lives in this same object.';
