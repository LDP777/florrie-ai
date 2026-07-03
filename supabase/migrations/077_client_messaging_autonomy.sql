-- 077: applied to prod via SQL editor 2026-07-04 (recorded for history).
-- Per-client autonomy override: the relationship is per-person knowledge only
-- the beautician has. 'florrie' = full autonomy, 'drafts' = always approve
-- first, 'just_me' = Florrie never initiates (quiet drafts only), NULL = auto.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS messaging_autonomy text
  CHECK (messaging_autonomy IN ('florrie', 'drafts', 'just_me'));
