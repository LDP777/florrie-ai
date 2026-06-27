-- 069_no_overlap_exclusion.sql
-- The complete double-booking guard. Migration 068's unique index only caught
-- two appointments sharing an EXACT start time. This adds a Postgres exclusion
-- constraint so two ACTIVE appointments can never have OVERLAPPING time ranges
-- for one beautician (e.g. 10:00-11:00 and 10:30-11:30), which the unique index
-- let through. This is the gold-standard fix: it runs under plain READ COMMITTED
-- and cannot be bypassed by an app-level race.
--
-- Prerequisite cleanup (already applied live, 2026-06-27): 20 imported appointments
-- formed 13 overlapping pairs purely because the importer stamped every appointment
-- at 60 minutes when the real bookings were spaced 30-45 minutes apart. Each was
-- capped to end exactly when the beautician's next appointment starts, recovering
-- the real spacing and clearing all overlaps, so this constraint validates cleanly.
--
-- The booking and manual-create routes catch SQLSTATE 23P01 (exclusion violation)
-- alongside 23505 (unique violation) and return a friendly 409.

create extension if not exists btree_gist;

alter table appointments add constraint appointments_no_overlap
  exclude using gist (
    beautician_id with =,
    tstzrange(starts_at, ends_at) with &&
  ) where (status in ('confirmed', 'pending', 'in_progress'));
