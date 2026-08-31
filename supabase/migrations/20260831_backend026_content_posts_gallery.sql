-- 026: make the Gallery tab a thing that can actually save.
--
-- 31 August 2026. frontend/src/pages/ContentAutopilot.jsx has a Gallery tab
-- for before/after pairs. handleSaveGalleryItem uploads BOTH photos to the
-- public bucket, and then inserts a content_posts row with
-- post_type: 'gallery'. Migration 001 says:
--
--   post_type TEXT DEFAULT 'before_after' CHECK (post_type IN (
--     'before_after', 'last_minute_availability', 'promotion',
--     'testimonial', 'general'))
--
-- so the insert has never once succeeded. The failure lands AFTER both
-- uploads, which is the worst place for it: two files are now sitting in
-- storage, nothing references them, and the owner is looking at "Could not
-- save that before and after". loadGallery then filters on the same
-- impossible post_type, so the tab is permanently empty no matter what she
-- does. It has been shipped in that state.
--
-- Two ways out were on the table: delete the tab, or make it work. It is
-- worth making work. A before/after portfolio is the thing this whole page
-- exists to feed, the upload half is already written and already correct
-- (public bucket, public urls, no blob: fallback), and the only missing
-- pieces are three columns and a wider CHECK.
--
-- THE THREE COLUMNS MATTER AS MUCH AS THE CHECK. The card renders
-- item.before_url, item.after_url and item.treatment_name, and the insert
-- wrote none of them: it put the AFTER photo in image_url and threw the
-- before photo away. So even with the CHECK widened, every pair would come
-- back from a page reload as two broken images with no name under them. The
-- frontend now writes all three.
--
-- Run by hand in the Supabase SQL editor. Idempotent, safe to re-run.
-- After running, RESTART Railway so PgBouncer's schema cache sees the change.

-- 1. The pair, and what it is of. image_url stays the AFTER photo, so a
-- gallery row can still be published as an ordinary post without a special
-- case anywhere in the publish path.
ALTER TABLE content_posts ADD COLUMN IF NOT EXISTS before_url      TEXT;
ALTER TABLE content_posts ADD COLUMN IF NOT EXISTS after_url       TEXT;
ALTER TABLE content_posts ADD COLUMN IF NOT EXISTS treatment_name  TEXT;

-- 2. The CHECK. Dropped by name first so this file can be run twice; ADD
-- CONSTRAINT has no IF NOT EXISTS. The five original values are carried over
-- verbatim, because every existing row holds one of them and a typo here
-- would refuse the next write to a table full of perfectly good posts.
ALTER TABLE content_posts DROP CONSTRAINT IF EXISTS content_posts_post_type_check;
ALTER TABLE content_posts ADD CONSTRAINT content_posts_post_type_check
  CHECK (post_type IN (
    'before_after', 'last_minute_availability', 'promotion',
    'testimonial', 'general',
    -- New. A portfolio pair, not a scheduled post: it is never picked up by
    -- the scheduler (status stays 'draft' and scheduled_for stays null) and
    -- the Drafts, Scheduled, Posted and Calendar views filter it out.
    'gallery'
  ));

COMMENT ON COLUMN content_posts.before_url IS
  'Public url of the BEFORE photo of a post_type=gallery pair. Public, not signed: Instagram fetches images server side, so a signed link is a guaranteed failure at publish time. Added 31 Aug 2026, when the Gallery tab was found to have never saved a single row.';
COMMENT ON COLUMN content_posts.after_url IS
  'Public url of the AFTER photo of a post_type=gallery pair. Mirrors image_url, which also holds the after photo so the pair can be published like any other post.';
COMMENT ON COLUMN content_posts.treatment_name IS
  'What the gallery pair is of, chosen from her own treatments list. Shown under the pair on the Gallery card.';
