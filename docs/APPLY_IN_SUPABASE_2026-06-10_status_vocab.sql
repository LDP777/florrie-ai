-- 056: appointments.status CHECK was missing 'cancelled', but three writers
-- use it: public self-cancel (booking.js manage/:token/cancel), expired-slot
-- cleanup, and voice cancel. Every one of those updates failed the constraint,
-- which is why client self-cancellation never worked. Allow both vocabularies.
ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_status_check;
ALTER TABLE appointments ADD CONSTRAINT appointments_status_check CHECK (status IN (
  'pending', 'confirmed', 'in_progress', 'completed',
  'cancelled', 'cancelled_by_client', 'cancelled_by_beautician',
  'no_show', 'rescheduled'
));
