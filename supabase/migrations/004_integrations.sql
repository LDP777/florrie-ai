-- Migration 004: Google Calendar + Accounting integrations

-- ═══════════════════════════════════════════════
-- 1. Google Calendar fields on beauticians
-- ═══════════════════════════════════════════════
ALTER TABLE beauticians ADD COLUMN IF NOT EXISTS google_calendar_connected BOOLEAN DEFAULT FALSE;
ALTER TABLE beauticians ADD COLUMN IF NOT EXISTS google_calendar_tokens JSONB; -- {access_token, refresh_token, expiry_date}
ALTER TABLE beauticians ADD COLUMN IF NOT EXISTS google_calendar_id TEXT DEFAULT 'primary';

-- Google event ID on appointments for two-way sync
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS google_event_id TEXT;
CREATE INDEX IF NOT EXISTS idx_appointments_google_event ON appointments(google_event_id);

-- ═══════════════════════════════════════════════
-- 2. Accounting integration fields
-- ═══════════════════════════════════════════════
ALTER TABLE beauticians ADD COLUMN IF NOT EXISTS xero_connected BOOLEAN DEFAULT FALSE;
ALTER TABLE beauticians ADD COLUMN IF NOT EXISTS xero_tokens JSONB;
ALTER TABLE beauticians ADD COLUMN IF NOT EXISTS xero_tenant_id TEXT;
ALTER TABLE beauticians ADD COLUMN IF NOT EXISTS quickbooks_connected BOOLEAN DEFAULT FALSE;
ALTER TABLE beauticians ADD COLUMN IF NOT EXISTS quickbooks_tokens JSONB;
ALTER TABLE beauticians ADD COLUMN IF NOT EXISTS quickbooks_realm_id TEXT;

-- Track which transactions/expenses have been synced to accounting
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS accounting_synced BOOLEAN DEFAULT FALSE;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS accounting_invoice_id TEXT;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS accounting_synced BOOLEAN DEFAULT FALSE;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS accounting_bill_id TEXT;

-- ═══════════════════════════════════════════════
-- 3. WhatsApp outbound message tracking
-- ═══════════════════════════════════════════════
ALTER TABLE messages ADD COLUMN IF NOT EXISTS whatsapp_message_id TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS template_name TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;
