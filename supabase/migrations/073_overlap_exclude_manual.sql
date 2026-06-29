-- 073_overlap_exclude_manual.sql
-- Re-scope the no-overlap exclusion constraint so it NO LONGER applies to
-- manually-entered appointments, while still fully protecting the public /
-- online booking flow.
--
-- Background: migration 069 added appointments_no_overlap, a gist EXCLUDE
-- constraint that blocks ANY two active appointments from overlapping for one
-- beautician. That correctly stops two clients grabbing the same slot on the
-- public booking page, but it ALSO hard-blocks the owner (Ellie) from
-- intentionally double-booking when she adds an appointment by hand from the
-- day calendar (back-to-back walk-ins, a quick top-up alongside a longer
-- treatment, mirroring two old-system bookings, etc). The New Appointment sheet
-- already warns her about the clash and offers an explicit "Add anyway", so the
-- intent is deliberate, the database should not override it.
--
-- Fix: rebuild the constraint with an added predicate so only NON-manual rows
-- participate in the overlap check. Because a row that fails the WHERE predicate
-- neither triggers the constraint NOR blocks other rows, this means:
--   * two manual appointments may overlap (Ellie can double-book on purpose)
--   * a manual appointment may overlap an online one (her call as the owner)
--   * two online/public bookings (booking_page, ai_front_desk, waitlist_fill,
--     comeback_engine, import, voice_note, or NULL booked_via) still can NEVER
--     overlap, so the public booking page stays fully protected.
--
-- The unique-start index from migration 068 (appointments_no_double_book) stays
-- as-is and still blocks two active appointments sharing an EXACT start time
-- regardless of source, and the booking + manual routes catch 23505 / 23P01 and
-- return a clear 409. So the public flow keeps both guards; manual loses only
-- the overlap guard, which is the intended behaviour.
--
-- Safe to run repeatedly. Paste into the Supabase SQL editor.

create extension if not exists btree_gist;

alter table appointments drop constraint if exists appointments_no_overlap;

alter table appointments add constraint appointments_no_overlap
  exclude using gist (
    beautician_id with =,
    tstzrange(starts_at, ends_at) with &&
  ) where (
    status in ('confirmed', 'pending', 'in_progress')
    and (booked_via is distinct from 'manual')
  );
