-- Launch sweep, 23 August 2026. Run in the Supabase SQL editor for
-- driyreevwogxngqyshtc, top to bottom. Every statement is idempotent, so a
-- re-run is safe.
--
-- NOTHING HERE IS REQUIRED FOR THE DEPLOY THAT JUST SHIPPED. Every new column
-- is written by a separate best-effort statement that logs and carries on if
-- the column is missing, precisely so the code could ship first. What you lose
-- until this runs is listed against each block.
--
-- AFTER RUNNING: restart Railway. Not redeploy, restart. PgBouncer caches the
-- schema and a column-add is invisible to it until the pool is rebuilt.

-- ---------------------------------------------------------------------------
-- 1. Instagram DM routing must not be a bet on one id.
--
-- Meta's webhook reference will only say entry.id is "the object's ID". The
-- connect flow learns three candidate ids and a stored one has already been
-- wrong once in production, which is why Ellie's DMs did not route until the id
-- was corrected by hand on 11 July. Store them all and match on any.
--
-- Until this runs: routing falls back to instagram_page_id alone, which is
-- today's behaviour, so nothing gets worse.
-- ---------------------------------------------------------------------------
alter table beauticians add column if not exists instagram_account_ids text[];

create index if not exists idx_beauticians_instagram_account_ids
  on beauticians using gin (instagram_account_ids);

update beauticians
   set instagram_account_ids = array[instagram_page_id]
 where instagram_page_id is not null
   and instagram_account_ids is null;

-- ---------------------------------------------------------------------------
-- 2. Let the health check warn BEFORE a token dies.
--
-- lib/health.js has always read this column. Nothing has ever written it, so
-- that warning has never once fired, which is how the 21 June token death ran
-- for five weeks with every outbound Instagram call failing silently.
--
-- Until this runs: no early warning, same as today.
-- ---------------------------------------------------------------------------
alter table beauticians add column if not exists instagram_token_expires_at timestamptz;

-- ---------------------------------------------------------------------------
-- 3. Why a post did not publish, on the card.
--
-- Until this runs: a failed post is marked failed with no reason shown.
-- ---------------------------------------------------------------------------
alter table content_posts add column if not exists failure_reason text;

-- ---------------------------------------------------------------------------
-- 4. media_kind lives only in docs/sql/20260709_voice_profile.sql and never in
--    supabase/migrations, so it may or may not be applied. This settles it.
-- ---------------------------------------------------------------------------
alter table content_posts add column if not exists media_kind text default 'feed';

-- ---------------------------------------------------------------------------
-- 5. Clear the placeholder handle.
--
-- instagram_page_name was written as the literal string "Instagram" when the
-- username came back empty at connect. The Settings card then shows
-- "Instagram" rather than her handle, and a Meta reviewer reads that as an
-- unconnected account. /api/instagram/status re-fills it live on the next
-- load, so clearing it is the fix, not a loss.
-- ---------------------------------------------------------------------------
update beauticians set instagram_page_name = null
 where instagram_page_name = 'Instagram';

-- ---------------------------------------------------------------------------
-- 6. Four fields the settings pages collect that have nowhere to go.
--
-- These four are the only ones in the whole features.js sweep with no
-- corresponding column. Until this runs the handler refuses them with a 400
-- naming the field, which is deliberate: quietly dropping what she typed is
-- worse than an error.
-- ---------------------------------------------------------------------------
alter table loyalty_config   add column if not exists redemption_rate        integer default 100;
alter table portal_settings  add column if not exists booking_buffer_minutes integer default 15;
alter table portal_settings  add column if not exists max_bookings_per_day   integer default 10;
alter table portal_settings  add column if not exists theme                  text    default 'light';

-- ---------------------------------------------------------------------------
-- 7. The rebook queue reads by due date every hour. Optional, cheap.
-- ---------------------------------------------------------------------------
create index if not exists rebook_reminders_due_idx
  on rebook_reminders (reminder_date)
  where sent = false;

-- ---------------------------------------------------------------------------
-- 8. DIAGNOSTIC, NOT A CHANGE. Run this and send me the result.
--
-- Migrations 007 and 023 both do CREATE TABLE IF NOT EXISTS referrals with
-- completely different shapes, so the live database has exactly one of them and
-- exactly one of routes/referrals.js and routes/features.js is broken against
-- it. The repo cannot tell me which. This can.
-- ---------------------------------------------------------------------------
select column_name, data_type
  from information_schema.columns
 where table_schema = 'public' and table_name = 'referrals'
 order by ordinal_position;

-- ---------------------------------------------------------------------------
-- 9. DIAGNOSTIC. Instagram cannot fetch an image from a private bucket, so a
--    private content-images bucket fails the Meta publishing screencast at the
--    last step. Nothing in the migrations creates this bucket.
-- ---------------------------------------------------------------------------
select id, public from storage.buckets where id = 'content-images';

-- If that comes back public = false, and only then:
--   update storage.buckets set public = true where id = 'content-images';
