-- WHO ACTUALLY WROTE THIS MESSAGE
--
-- Ellie's clients could tell Florrie's replies were not her. The idiolect
-- engine (services/voice-profile.js) was supposed to stop that. It could not,
-- because it had no way of knowing whose words it was reading.
--
-- Its filter for "her own writing" was:
--     .eq('direction','outbound').or('ai_handled.is.null,ai_handled.eq.false')
--
-- messages.ai_handled defaults to FALSE (001_initial_schema.sql:257), and six
-- insert sites never set it at all. So every one of these was fed back in as
-- Ellie's own prose:
--   services/messaging.js:229      every approved Florrie draft from the outbox
--   services/messaging.js:229      the auto-cancel notice from services/cleanup.js
--   routes/notifications.js:75     the canned reminder body
--   routes/consultation-forms.js:711  the consultation form SMS
--   routes/instagram-webhooks.js:394  the canned WhatsApp redirect
--   routes/escalations.js:186      any Florrie draft she edited before sending
--
-- A model trained on its own output converges on the average of its own
-- output. That is the whole bug: the longer Florrie ran, the more she sounded
-- like a booking confirmation, and the less she sounded like Ellie.
--
-- ai_handled cannot be repaired in place, because it means something else and
-- other code reads it (inbox badges, escalation counts). This is a separate
-- axis: not "did the AI handle the thread", but "whose sentences are these".
--
-- HOW TO APPLY
--   1. Run it in Supabase.
--   2. RESTART Railway, not redeploy. PgBouncer caches the PostgREST schema,
--      so a fresh column stays invisible to the API until the process restarts.
--
-- Idempotent throughout. No BEGIN/COMMIT: backend/scripts/migrate.js wraps each
-- file in its own transaction and writes the ledger row inside it.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. messages.authored_by
-- ─────────────────────────────────────────────────────────────────────────
-- Values, and why each one exists:
--   'client'    inbound. Never training data for her voice, obviously.
--   'human'     the salon owner typed it herself. THE ONLY training data.
--   'ai'        Florrie wrote it and it went out as written (auto-send, or she
--               approved it verbatim). Training on this is the feedback loop.
--   'ai_edited' Florrie wrote it, she changed it, it went out. Tempting to
--               train on and still wrong: the sentence shape, length and
--               vocabulary are all still Florrie's, she only moved a few words.
--               Excluded, and kept as its own value so the correction path
--               (learnFromCorrection) can keep using it.
--   'template'  an approved WhatsApp template or fixed canned copy.
--   'system'    automated prose the product composed, not a template.
--   'unknown'   pre-migration history. See the backfill note below.
--
-- No CHECK constraint. A value nobody enumerated would otherwise be rejected
-- whole at insert time and lose a real message, and the reader
-- (lib/idiolect.js) treats anything it does not recognise as not-hers, which
-- is the safe direction anyway.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS authored_by TEXT;

COMMENT ON COLUMN messages.authored_by IS
  'Whose sentences these are: client, human, ai, ai_edited, template, system, unknown. Separate axis from ai_handled (which means "did the AI deal with this thread"). Only human rows may train the voice profile.';

-- The shape of the voice-profile query: one beautician, her own outbound words,
-- newest first.
CREATE INDEX IF NOT EXISTS idx_messages_authorship
  ON messages (beautician_id, direction, authored_by, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Backfill, honestly
-- ─────────────────────────────────────────────────────────────────────────
-- For most historical outbound rows the author is genuinely unknowable: three
-- different writers all inserted with the same default and left no other trace.
-- Rather than guess and quietly poison the training set again, they are marked
-- 'unknown' and the trainer refuses to treat them as hers.
--
-- Two groups CAN be known from what is already on the row, so they are set:
--   template_name IS NOT NULL      only notifications.js writes that, and only
--                                  for an approved WhatsApp template.
--   digital_employee IS NOT NULL   only Florrie's own paths set it.
--
-- Everything else outbound is 'unknown'. services/voice-profile.js has a
-- documented, capped bootstrap for that set: it subtracts every message whose
-- text matches a known Florrie draft (messages.ai_response, outbound_sends.body)
-- and every message shaped like automated copy, then builds a LOW confidence
-- profile from what is left, flagged provenance='bootstrap'. As real 'human'
-- rows accumulate from the inbox, the profile promotes itself and the bootstrap
-- is never used again.
UPDATE messages SET authored_by = 'client'
  WHERE authored_by IS NULL AND direction = 'inbound';

UPDATE messages SET authored_by = 'template'
  WHERE authored_by IS NULL AND direction = 'outbound' AND template_name IS NOT NULL;

UPDATE messages SET authored_by = 'ai'
  WHERE authored_by IS NULL AND direction = 'outbound' AND digital_employee IS NOT NULL;

UPDATE messages SET authored_by = 'unknown'
  WHERE authored_by IS NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. beauticians.voice_profile
-- ─────────────────────────────────────────────────────────────────────────
-- These two have existed in code since 9 July and in NO migration: the only
-- copy lives in docs/sql/20260709_voice_profile.sql, and supabase/migrations
-- /README.md is explicit that docs is not a migration source ("if a .sql file
-- changes the shape of the database and it is not in here, it does not exist").
-- If production never had them, buildVoiceProfile's update failed every week,
-- logged one warn line, and returned null, and buildVoiceGuide rendered an
-- empty string into every reply prompt. That is silent, weekly, and exactly
-- the shape of "her clients could tell". IF NOT EXISTS makes this a no-op if
-- Levi did paste it in by hand.
ALTER TABLE beauticians ADD COLUMN IF NOT EXISTS voice_profile JSONB;
ALTER TABLE beauticians ADD COLUMN IF NOT EXISTS voice_profile_updated_at TIMESTAMPTZ;

COMMENT ON COLUMN beauticians.voice_profile IS
  'Her idiolect: measured style features, verbatim example messages, and provenance. Written by services/voice-profile.js, read by lib/idiolect.js at reply time.';
