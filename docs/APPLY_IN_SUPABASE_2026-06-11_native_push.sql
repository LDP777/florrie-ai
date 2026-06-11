-- 060: Native push tokens (real APNs for the Capacitor iOS app).
--
-- The iOS app registers with Apple via @capacitor/push-notifications and
-- gets back an APNs device token. The frontend POSTs it to
-- /api/push/native-token and the backend fans booking/escalation pushes
-- out to these tokens alongside the existing web-push subscriptions.
--
-- token is UNIQUE so re-registration is an idempotent upsert. Rows are
-- deleted server-side when Apple reports the token dead (410 / BadDeviceToken).
--
-- Service-role only: RLS is enabled with NO anon/authenticated policies.
-- All reads/writes go through the backend with the service key.

CREATE TABLE IF NOT EXISTS native_push_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  platform TEXT DEFAULT 'ios',
  created_at TIMESTAMPTZ DEFAULT now(),
  last_seen_at TIMESTAMPTZ DEFAULT now()
);

-- Fan-out lookup: all tokens for one beautician.
CREATE INDEX IF NOT EXISTS idx_native_push_tokens_beautician
  ON native_push_tokens (beautician_id);

ALTER TABLE native_push_tokens ENABLE ROW LEVEL SECURITY;
-- Intentionally no policies: anon/authenticated get nothing, service role bypasses RLS.

COMMENT ON TABLE native_push_tokens IS
  'APNs/FCM device tokens for the native Capacitor app. Service-role access only.';
COMMENT ON COLUMN native_push_tokens.token IS
  'APNs device token (hex) as delivered by @capacitor/push-notifications registration.';
