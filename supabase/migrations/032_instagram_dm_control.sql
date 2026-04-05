-- Migration 032: Instagram DM control — mode selector + redirect tracking

-- Mode for handling incoming Instagram DMs:
--   'ai'       — AI Front Desk handles replies (existing behaviour)
--   'redirect' — Send one WhatsApp redirect reply, then stop handling
--   'off'      — Store messages only, no auto-reply
ALTER TABLE beauticians
  ADD COLUMN IF NOT EXISTS instagram_dm_mode        TEXT DEFAULT 'ai',
  ADD COLUMN IF NOT EXISTS instagram_redirect_message TEXT;

ALTER TABLE beauticians
  ADD CONSTRAINT beauticians_instagram_dm_mode_check
    CHECK (instagram_dm_mode IN ('ai', 'redirect', 'off'));

-- Track when we last sent the redirect message to each client
-- so we don't spam them on every message
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS instagram_redirect_sent_at TIMESTAMPTZ;

COMMENT ON COLUMN beauticians.instagram_dm_mode IS 'ai | redirect | off — controls Instagram DM handling';
COMMENT ON COLUMN beauticians.instagram_redirect_message IS 'Custom message sent when mode=redirect. Falls back to default wa.me link.';
COMMENT ON COLUMN clients.instagram_redirect_sent_at IS 'When we last sent the WhatsApp redirect to this client (deduplication)';
