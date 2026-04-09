-- Add Instagram integration columns
ALTER TABLE beauticians
  ADD COLUMN IF NOT EXISTS instagram_page_id TEXT,
  ADD COLUMN IF NOT EXISTS instagram_page_token TEXT;

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS instagram_id TEXT;

-- Index for webhook lookups
CREATE INDEX IF NOT EXISTS idx_beauticians_instagram_page_id
  ON beauticians (instagram_page_id) WHERE instagram_page_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_clients_instagram_id
  ON clients (beautician_id, instagram_id) WHERE instagram_id IS NOT NULL;
