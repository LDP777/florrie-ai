-- Multi-location groundwork — add location_id FK to key tables.
-- All columns are NULLABLE so existing single-location users are unaffected.

-- Extend locations table with working hours and booking slug
ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS booking_slug TEXT,
  ADD COLUMN IF NOT EXISTS email TEXT,
  ADD COLUMN IF NOT EXISTS postcode TEXT,
  ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS timezone TEXT DEFAULT 'Europe/London',
  ADD COLUMN IF NOT EXISTS notes TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_locations_booking_slug
  ON locations (booking_slug) WHERE booking_slug IS NOT NULL;

-- Add location_id to appointments
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES locations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_appointments_location
  ON appointments (beautician_id, location_id, starts_at);

-- Add location_id to treatments (for location-specific pricing)
ALTER TABLE treatments
  ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES locations(id) ON DELETE SET NULL;

-- Add location_id to working_hours
-- (Each location can have different open hours)
ALTER TABLE working_hours
  ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES locations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_working_hours_location
  ON working_hours (beautician_id, location_id, day_of_week);

-- Add location_id to team_members
-- (Staff assigned to specific locations)
ALTER TABLE team_members
  ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES locations(id) ON DELETE SET NULL;

-- Add location_id to retail_products
ALTER TABLE retail_products
  ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES locations(id) ON DELETE SET NULL;

-- Location-specific working hours exceptions
ALTER TABLE hours_exceptions
  ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES locations(id) ON DELETE SET NULL;

-- Add default_location_id to beauticians for quick switching
ALTER TABLE beauticians
  ADD COLUMN IF NOT EXISTS default_location_id UUID REFERENCES locations(id) ON DELETE SET NULL;
