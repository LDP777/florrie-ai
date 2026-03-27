-- Florrie.ai — Sprint 2: Team Members + Notification Preferences
-- Created: 2026-03-25

-- ============================================================
-- TEAM MEMBERS (staff who work under a beautician's account)
-- ============================================================
CREATE TABLE team_members (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,

  -- Profile
  first_name TEXT NOT NULL,
  last_name TEXT,
  email TEXT,
  phone TEXT,
  avatar_url TEXT,
  role TEXT DEFAULT 'stylist' CHECK (role IN ('stylist', 'assistant', 'admin')),

  -- Permissions
  can_manage_bookings BOOLEAN DEFAULT true,
  can_view_clients BOOLEAN DEFAULT true,
  can_manage_treatments BOOLEAN DEFAULT false,
  can_view_money BOOLEAN DEFAULT false,

  -- Working hours (same JSONB format as beauticians)
  working_hours JSONB,

  -- Pricing
  price_per_month_cents INTEGER DEFAULT 2500, -- £25/mo per seat

  -- Status
  is_active BOOLEAN DEFAULT true,
  invited_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- NOTIFICATION PREFERENCES
-- ============================================================
ALTER TABLE beauticians ADD COLUMN IF NOT EXISTS notification_prefs JSONB DEFAULT '{
  "booking_confirmed": {"email": true, "push": true, "sms": false},
  "booking_cancelled": {"email": true, "push": true, "sms": false},
  "reminder_24h": {"email": true, "push": true, "sms": false},
  "reminder_1h": {"email": false, "push": true, "sms": false},
  "ai_escalation": {"email": true, "push": true, "sms": false},
  "weekly_digest": {"email": true, "push": false, "sms": false},
  "payment_received": {"email": true, "push": true, "sms": false},
  "new_review": {"email": true, "push": true, "sms": false}
}'::jsonb;

-- Client reminder preferences (what gets sent TO clients)
ALTER TABLE beauticians ADD COLUMN IF NOT EXISTS client_reminder_prefs JSONB DEFAULT '{
  "booking_confirmation": true,
  "reminder_24h": true,
  "reminder_1h": false,
  "aftercare_followup": true,
  "rebook_nudge": true,
  "rebook_nudge_days": 7,
  "channel": "whatsapp",
  "fallback_channel": "email"
}'::jsonb;

-- RLS
ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY team_members_own ON team_members
  FOR ALL USING (beautician_id IN (SELECT id FROM beauticians WHERE auth_id = auth.uid()));

-- Indexes
CREATE INDEX idx_team_members_beautician ON team_members(beautician_id);

-- Updated_at trigger
CREATE TRIGGER set_updated_at BEFORE UPDATE ON team_members
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
