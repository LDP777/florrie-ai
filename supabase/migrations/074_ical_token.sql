-- 074_ical_token.sql
-- A per-beautician secret token that gates the private iCal subscribe feed
-- (GET /api/calendar/feed/:token.ics). The feed is unauthenticated by design
-- so Apple Calendar / Google Calendar can poll it without a login, so the only
-- thing standing between a stranger and her schedule is this unguessable token.
--
-- Nullable: the backend lazily generates one (crypto.randomBytes) the first time
-- she opens "Sync to my calendar", so existing rows need no backfill. To revoke
-- a leaked URL, null this column (or set a fresh value) and the old link 404s.
ALTER TABLE beauticians ADD COLUMN IF NOT EXISTS ical_token TEXT;

-- Unique so a token resolves to exactly one beautician, and indexed for the
-- per-request lookup the feed does on every calendar poll.
CREATE UNIQUE INDEX IF NOT EXISTS beauticians_ical_token_idx
  ON beauticians (ical_token)
  WHERE ical_token IS NOT NULL;
