-- 025: content_posts.media_kind and content_posts.failure_reason, which
-- supabase/migrations has never contained.
--
-- 31 August 2026. Both columns are read and written by shipped code and
-- neither has ever been in a migration. They exist only in two files that are
-- run by hand and may or may not have been:
--
--   docs/sql/20260709_voice_profile.sql        media_kind
--   docs/SQL_2026-08-23_LAUNCH_SWEEP.sql       both
--
-- A column that lives only in a file somebody has to remember to paste into
-- the SQL editor is not a column. What it actually costs:
--
--   media_kind. frontend/src/pages/ContentAutopilot.jsx sends media_kind on
--   the ONLY screen that attaches a photo to a draft (handleSaveDraft).
--   PostgREST rejects the WHOLE insert when one column is unknown, so on a
--   database without it "Save as Draft" fails every single time, for every
--   post, with an error about a column the owner has never heard of. The
--   backend reads it too (post.media_kind === 'story' picks the STORIES
--   publish flow), where a missing column merely means everything is a feed
--   post.
--
--   failure_reason. services/content-autopilot.js markPostFailed already
--   treats it as optional and writes it in a second statement precisely so a
--   missing column cannot take the status write down with it. That care stops
--   being necessary once the column is really there, and until then a failed
--   post says only "failed" and never why.
--
-- Run by hand in the Supabase SQL editor. Idempotent, safe to re-run, and a
-- no-op on any database where the two hand-run files were already pasted.
-- After running, RESTART Railway so PgBouncer's schema cache sees the change.

-- Which Instagram surface this post targets. 'feed' or 'story'. The default
-- matches docs/sql/20260709_voice_profile.sql exactly, so re-running cannot
-- introduce a second, different default on a database that already has it.
ALTER TABLE content_posts ADD COLUMN IF NOT EXISTS media_kind TEXT DEFAULT 'feed';

-- Why a post did not publish, in words, so the card can say it.
ALTER TABLE content_posts ADD COLUMN IF NOT EXISTS failure_reason TEXT;

-- When a publish was last claimed, and by nothing else: this is the atomic
-- claim that stops the same post reaching the profile twice. publishPost takes
-- it immediately before the first call to Meta and hands it back on failure,
-- and a claim older than ten minutes is reclaimable so a process that died
-- mid-publish cannot lock a post out forever. See the comment on
-- claimForPublish in backend/src/services/content-autopilot.js.
--
-- 31 August 2026: until today nothing checked post.status or
-- external_post_id before publishing, and the write that marks a post 'posted'
-- had its error unread, so a post could sit at 'approved' with a live
-- "Approve & Post" button under it while already being on her grid.
ALTER TABLE content_posts ADD COLUMN IF NOT EXISTS publish_claimed_at TIMESTAMPTZ;

-- Rows that predate the column are feed posts: that is what the publish path
-- did for all of them, so backfilling anything else would rewrite history.
UPDATE content_posts SET media_kind = 'feed' WHERE media_kind IS NULL;

COMMENT ON COLUMN content_posts.media_kind IS
  'feed | story. Read by publishPost in backend/src/services/content-autopilot.js to choose the STORIES container flow, written by the composer in frontend/src/pages/ContentAutopilot.jsx. Added to migrations 31 Aug 2026; it had existed only in docs/sql since 9 July, which meant Save as Draft failed outright anywhere that file had not been pasted.';

COMMENT ON COLUMN content_posts.publish_claimed_at IS
  'Atomic publish claim. Set by publishPost in backend/src/services/content-autopilot.js immediately before the first Meta call, cleared on failure, left set on success. A claim older than ten minutes is treated as dead and may be retaken. NULL means nobody is publishing this post.';

COMMENT ON COLUMN content_posts.failure_reason IS
  'Why the last publish attempt failed, in the words Meta used, truncated to 500 chars by markPostFailed. Shown on the draft card so a failed post is not visually identical to one nobody has touched.';
