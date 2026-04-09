-- Locations table for multi-location business management
CREATE TABLE IF NOT EXISTS locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  address TEXT,
  phone TEXT,
  is_primary BOOLEAN DEFAULT false,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'setup', 'archived')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Index for efficient queries
CREATE INDEX IF NOT EXISTS idx_locations_beautician
ON locations(beautician_id);

CREATE INDEX IF NOT EXISTS idx_locations_primary
ON locations(beautician_id, is_primary) WHERE is_primary = true;

-- Enable RLS
ALTER TABLE locations ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Beauticians can only see their own locations
CREATE POLICY "beauticians_can_view_own_locations"
  ON locations
  FOR SELECT
  USING (beautician_id = auth.uid());

CREATE POLICY "beauticians_can_insert_own_locations"
  ON locations
  FOR INSERT
  WITH CHECK (beautician_id = auth.uid());

CREATE POLICY "beauticians_can_update_own_locations"
  ON locations
  FOR UPDATE
  USING (beautician_id = auth.uid())
  WITH CHECK (beautician_id = auth.uid());

CREATE POLICY "beauticians_can_delete_own_locations"
  ON locations
  FOR DELETE
  USING (beautician_id = auth.uid());
