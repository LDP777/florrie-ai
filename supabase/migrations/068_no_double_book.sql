-- 068_no_double_book.sql
-- Final guard against double-booking. The booking flow does a conflict check then
-- inserts, leaving a small race window where two clients could grab the same slot,
-- or a double-submit could duplicate a booking. This partial unique index makes the
-- database the arbiter: two ACTIVE appointments can never share the same start time
-- for one beautician. The booking + manual-create routes catch the violation
-- (Postgres 23505) and return a friendly "pick another slot" instead of a 500.
create unique index if not exists appointments_no_double_book
  on appointments (beautician_id, starts_at)
  where status in ('confirmed', 'pending', 'in_progress');
