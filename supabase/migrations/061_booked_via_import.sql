-- 061: allow booked_via = 'import' for appointments brought over from other
-- systems (Timely CSV import, /api/import/appointments). The import route
-- tries 'import' first and falls back to 'manual' until this is applied, so
-- nothing breaks either way. Paste into the Supabase SQL editor.
ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_booked_via_check;
ALTER TABLE appointments ADD CONSTRAINT appointments_booked_via_check CHECK (booked_via IN (
  'booking_page', 'ai_front_desk', 'manual', 'voice_note',
  'comeback_engine', 'waitlist_fill', 'import'
));
