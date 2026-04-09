-- Photo Consent table for GDPR-compliant photo permission management
CREATE TABLE IF NOT EXISTS photo_consents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  consent_type TEXT NOT NULL CHECK (consent_type IN ('before_after', 'social_media', 'marketing', 'portfolio')),
  granted BOOLEAN DEFAULT false,
  granted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  signature_data TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Index for efficient lookups by beautician and client
CREATE INDEX IF NOT EXISTS idx_photo_consents_beautician_client
ON photo_consents(beautician_id, client_id);

-- Index for queries by beautician
CREATE INDEX IF NOT EXISTS idx_photo_consents_beautician
ON photo_consents(beautician_id, created_at DESC);

-- Enable RLS
ALTER TABLE photo_consents ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Beauticians can only see their own photo consents
CREATE POLICY "beauticians_can_view_own_photo_consents"
  ON photo_consents
  FOR SELECT
  USING (beautician_id = auth.uid());

CREATE POLICY "beauticians_can_insert_own_photo_consents"
  ON photo_consents
  FOR INSERT
  WITH CHECK (beautician_id = auth.uid());

CREATE POLICY "beauticians_can_update_own_photo_consents"
  ON photo_consents
  FOR UPDATE
  USING (beautician_id = auth.uid())
  WITH CHECK (beautician_id = auth.uid());

CREATE POLICY "beauticians_can_delete_own_photo_consents"
  ON photo_consents
  FOR DELETE
  USING (beautician_id = auth.uid());
