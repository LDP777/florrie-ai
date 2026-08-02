-- schema_migrations: the ledger that says which migrations this database has.
--
-- WHY THIS EXISTS
-- Until now there was no answer to "has this migration been applied". There
-- were three competing migration directories, no runner, and no tracking
-- table, so every migration was pasted into the Supabase SQL editor by hand
-- and the only record of what ran was a human memory and a commit message.
-- The codebase is written defensively around the drift that produced:
-- isMissingColumnError is checked in six places, because the code genuinely
-- cannot know whether a column exists.
--
-- One row per applied file. backend/scripts/migrate.js writes it.
--
-- checksum is a sha256 of the file contents at the moment it was applied. It
-- is not a lock, it is evidence: if a historic migration file is edited after
-- the fact, the runner can say so instead of quietly running a different
-- statement against the next environment.
--
-- Safe to run twice.

CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 'runner' when backend/scripts/migrate.js executed it, 'baseline' when it
  -- was recorded as already applied because a human had run it by hand in the
  -- Supabase SQL editor before the runner existed.
  applied_by TEXT NOT NULL DEFAULT 'runner',
  duration_ms INTEGER
);

COMMENT ON TABLE schema_migrations IS 'One row per applied migration file. Written by backend/scripts/migrate.js. A file in supabase/migrations with no row here has not been applied.';
COMMENT ON COLUMN schema_migrations.checksum IS 'sha256 of the file contents when applied. A mismatch means the file was edited after it ran.';
COMMENT ON COLUMN schema_migrations.applied_by IS 'runner = executed by migrate.js. baseline = recorded without executing, because it was applied by hand before the ledger existed.';
