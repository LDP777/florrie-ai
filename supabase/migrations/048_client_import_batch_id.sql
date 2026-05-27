-- Add import_batch_id to clients so we can group all rows from a single import
-- and offer "undo last import" for a short window after the import finishes.
--
-- The execute route generates one UUID per migration call and tags every row
-- it inserts with that UUID. The Clients page reads ?just_imported=<uuid> from
-- the URL and filters the list to just-landed rows. The /api/migrate/undo
-- route looks up rows by (beautician_id, import_batch_id), enforces a 1-hour
-- window against clients.created_at, and cascade-deletes them.

BEGIN;

ALTER TABLE clients ADD COLUMN IF NOT EXISTS import_batch_id UUID;

-- Partial index so the lookup is cheap and the index stays tiny. Most rows
-- will have NULL import_batch_id (manually added or pre-import).
CREATE INDEX IF NOT EXISTS idx_clients_import_batch
  ON clients(beautician_id, import_batch_id)
  WHERE import_batch_id IS NOT NULL;

COMMIT;
