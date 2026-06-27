-- Photo consent: align the table with what the app actually sends and shows.
--
-- The original table (015) modelled a single consent_type + granted boolean.
-- The Photo Consent page works with a richer shape: a request has a status
-- (pending / granted / declined), a list of permitted uses (portfolio,
-- booking-page, instagram, ...), a request method (digital / paper) and an
-- optional expiry. These columns add that without dropping the legacy ones,
-- so existing rows keep working.

ALTER TABLE photo_consents
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'granted', 'declined', 'expired'));

ALTER TABLE photo_consents
  ADD COLUMN IF NOT EXISTS permitted_uses TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE photo_consents
  ADD COLUMN IF NOT EXISTS method TEXT;

ALTER TABLE photo_consents
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- consent_type was NOT NULL with a tight CHECK in 015. The app no longer sends
-- it (uses permitted_uses instead), so make it optional going forward.
ALTER TABLE photo_consents
  ALTER COLUMN consent_type DROP NOT NULL;

-- Backfill status for any legacy rows so the page reads them correctly.
UPDATE photo_consents
  SET status = CASE
    WHEN revoked_at IS NOT NULL THEN 'declined'
    WHEN granted IS TRUE THEN 'granted'
    ELSE 'pending'
  END
  WHERE status = 'pending';
