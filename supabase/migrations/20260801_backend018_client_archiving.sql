-- 018: reversible client archiving.
-- Ellie asked to "remove clients if they haven't been with me for over 12 months".
-- Decision: archive, never delete. An archived client keeps every appointment,
-- message and transaction; they are simply hidden from the client list. If they
-- message or book again the backend clears archived_at automatically.
--
-- Run by hand in the Supabase SQL editor (idempotent, safe to re-run).

ALTER TABLE clients ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

-- Partial index: the list queries filter on "archived_at IS NULL" per
-- beautician, and the archived view is tiny, so index only the archived rows.
CREATE INDEX IF NOT EXISTS idx_clients_archived
  ON clients (beautician_id, archived_at)
  WHERE archived_at IS NOT NULL;

COMMENT ON COLUMN clients.archived_at IS
  'Soft archive: hidden from client lists, never deleted. Cleared automatically when the client messages or books again.';
