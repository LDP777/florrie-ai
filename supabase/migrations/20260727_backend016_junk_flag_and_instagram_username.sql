-- 016_junk_flag_and_instagram_username.sql
-- Two additions, both idempotent, both safe to re-run.
--
-- 1. messages.is_junk / messages.junk_reason
--    Instagram brings a lot of outreach that is not a client: cold service
--    pitches, follower selling, wingman messages, crypto. Every one of those
--    escalated like a real enquiry, which is why the nav badge read "99+" and
--    told Ellie nothing. Flagged messages are still stored and still visible,
--    they just stop escalating, stop pushing, and stop counting.
--    Classified by backend/src/lib/junk-classifier.js at receipt time.
--
-- 2. clients.instagram_username
--    The @handle, kept apart from first_name. fetchInstagramIdentity already
--    asks Instagram for name,username; until now the username was only ever
--    used as a fallback display name and then thrown away.
--
-- After applying, RESTART the Railway service (not redeploy). PgBouncer caches
-- the schema and will keep 42703-ing on the new columns otherwise.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_junk     boolean NOT NULL DEFAULT false;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS junk_reason text;

ALTER TABLE clients  ADD COLUMN IF NOT EXISTS instagram_username text;

-- The badge query is "distinct clients with an unresolved escalation in the
-- last 30 days, junk excluded", run on every app open. This partial index
-- keeps it off a sequential scan as the messages table grows.
CREATE INDEX IF NOT EXISTS idx_messages_open_escalations
  ON messages (beautician_id, created_at DESC)
  WHERE escalated AND NOT resolved AND NOT is_junk;

-- Finding an Instagram client by handle, and the nightly username backfill.
CREATE INDEX IF NOT EXISTS idx_clients_instagram_username
  ON clients (beautician_id, instagram_username)
  WHERE instagram_username IS NOT NULL;
