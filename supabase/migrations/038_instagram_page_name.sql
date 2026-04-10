-- Add instagram_page_name to beauticians for display in Settings UI.
-- instagram_page_id and instagram_page_token were added in migration 021.

ALTER TABLE beauticians
  ADD COLUMN IF NOT EXISTS instagram_page_name TEXT;

COMMENT ON COLUMN beauticians.instagram_page_name IS 'Display name of the connected Facebook Page (shown in Settings UI)';
