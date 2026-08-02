-- 014_confirmation_sent_at.sql
--
-- Ellie needs to prove, in a no-show dispute, when a client's confirmation was
-- sent. appointments.created_at already gives the booking time; this stamps
-- when the confirmation actually went out. notifyBookingConfirmed sets it.
alter table appointments
  add column if not exists confirmation_sent_at timestamptz;
