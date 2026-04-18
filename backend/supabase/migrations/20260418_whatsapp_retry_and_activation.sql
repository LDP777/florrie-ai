-- WhatsApp registration: retry queue + pending-activation flag.
--
-- whatsapp_retry_at      The next time the background worker should re-try a
--                        cooldown_active number. Set by /register when Meta
--                        returns a cooldown diagnosis, cleared on success.
-- whatsapp_retry_reason  The diagnosis code that triggered the retry (e.g.
--                        "cooldown_active"). Keeps the worker idempotent and
--                        lets us surface it in the UI.
-- whatsapp_retry_attempts
--                        Count of automated retries so we can back off and cap.
-- whatsapp_pending_activation
--                        True between /verify success and the first confirmed
--                        webhook/status ping from Meta. Gates whatsapp_connected
--                        so the UI doesn't lie to the user.

ALTER TABLE beauticians
  ADD COLUMN IF NOT EXISTS whatsapp_retry_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS whatsapp_retry_reason      TEXT,
  ADD COLUMN IF NOT EXISTS whatsapp_retry_attempts    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS whatsapp_pending_activation BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_beauticians_wa_retry_at
  ON beauticians(whatsapp_retry_at)
  WHERE whatsapp_retry_at IS NOT NULL;

COMMENT ON COLUMN beauticians.whatsapp_retry_at IS 'Next scheduled automated retry for WhatsApp registration. Set when Meta returns cooldown_active.';
COMMENT ON COLUMN beauticians.whatsapp_retry_reason IS 'Reason for the queued retry. Values: cooldown_active | rate_limit | pending_activation.';
COMMENT ON COLUMN beauticians.whatsapp_retry_attempts IS 'Number of automated retry attempts so far. Capped to prevent infinite loops.';
COMMENT ON COLUMN beauticians.whatsapp_pending_activation IS 'True after /verify succeeded but before Meta confirms Cloud API status. Prevents false "connected" UI.';
