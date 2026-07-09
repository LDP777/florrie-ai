-- Idiolect engine: per-beautician voice profile distilled weekly from her own
-- outbound messages and captions. Read by caption + reply prompts.
ALTER TABLE beauticians ADD COLUMN IF NOT EXISTS voice_profile JSONB;
ALTER TABLE beauticians ADD COLUMN IF NOT EXISTS voice_profile_updated_at TIMESTAMPTZ;

-- Stories support: which surface a content post targets.
ALTER TABLE content_posts ADD COLUMN IF NOT EXISTS media_kind TEXT DEFAULT 'feed';
