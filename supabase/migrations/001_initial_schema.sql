-- Florrie.ai — Initial Database Schema
-- All core entities from PRD, designed for Supabase (PostgreSQL)
-- Created: 2026-03-24

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- BEAUTICIAN (the primary user)
-- ============================================================
CREATE TABLE beauticians (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  auth_id UUID UNIQUE NOT NULL, -- links to Supabase Auth user

  -- Profile
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  business_name TEXT,
  email TEXT UNIQUE NOT NULL,
  phone TEXT,
  avatar_url TEXT,

  -- Business settings
  booking_slug TEXT UNIQUE, -- e.g. "ellie-brows" → florrie.ai/book/ellie-brows
  timezone TEXT DEFAULT 'Europe/London',
  currency TEXT DEFAULT 'GBP',
  locale TEXT DEFAULT 'en-GB',

  -- Working hours (JSONB: { mon: { start: "09:00", end: "17:00" }, ... })
  working_hours JSONB DEFAULT '{
    "mon": {"start": "09:00", "end": "17:00"},
    "tue": {"start": "09:00", "end": "17:00"},
    "wed": {"start": "09:00", "end": "17:00"},
    "thu": {"start": "09:00", "end": "17:00"},
    "fri": {"start": "09:00", "end": "17:00"},
    "sat": null,
    "sun": null
  }'::jsonb,

  -- AI settings
  tone_model JSONB DEFAULT '{}', -- learned communication style
  confidence_threshold NUMERIC(3,2) DEFAULT 0.90, -- below this → escalate
  auto_reply_enabled BOOLEAN DEFAULT true,

  -- Stripe
  stripe_account_id TEXT, -- Stripe Connect account
  stripe_onboarding_complete BOOLEAN DEFAULT false,

  -- Subscription
  subscription_status TEXT DEFAULT 'trial' CHECK (subscription_status IN ('trial', 'active', 'past_due', 'cancelled')),
  trial_ends_at TIMESTAMPTZ,

  -- Branding
  brand_color TEXT DEFAULT '#C4A882', -- warm gold default
  brand_font TEXT DEFAULT 'DM Sans',
  logo_url TEXT,

  -- Social connections
  whatsapp_phone_id TEXT,
  whatsapp_token TEXT,
  instagram_page_id TEXT,
  instagram_token TEXT,
  google_place_id TEXT,

  -- Metadata
  onboarding_completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- TREATMENTS (service menu)
-- ============================================================
CREATE TABLE treatments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,

  name TEXT NOT NULL,
  description TEXT,
  duration_minutes INTEGER NOT NULL, -- chair time
  buffer_minutes INTEGER DEFAULT 0, -- cleanup/transition time
  price_cents INTEGER NOT NULL, -- stored in pence (e.g. 3500 = £35.00)
  deposit_cents INTEGER DEFAULT 0, -- required deposit at booking

  -- Categorisation
  category TEXT, -- e.g. "Brows", "Lashes", "Skin"

  -- Product costs (for smart pricing)
  product_cost_cents INTEGER DEFAULT 0,

  -- Contraindications
  contraindications TEXT[] DEFAULT '{}', -- e.g. {"pregnancy", "retinol_use"}

  -- Availability
  is_active BOOLEAN DEFAULT true,
  booking_enabled BOOLEAN DEFAULT true, -- show on booking page

  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- CLIENTS
-- ============================================================
CREATE TABLE clients (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,

  -- Contact
  first_name TEXT NOT NULL,
  last_name TEXT,
  email TEXT,
  phone TEXT,

  -- Communication channels
  whatsapp_id TEXT, -- WhatsApp contact ID
  instagram_id TEXT, -- Instagram user ID
  preferred_channel TEXT DEFAULT 'whatsapp' CHECK (preferred_channel IN ('whatsapp', 'instagram', 'sms', 'email')),

  -- Marketing consent (GDPR)
  marketing_consent BOOLEAN DEFAULT false,
  marketing_consent_at TIMESTAMPTZ,
  health_data_consent BOOLEAN DEFAULT false,
  health_data_consent_at TIMESTAMPTZ,

  -- Intelligence (built by the agent loop)
  preferences JSONB DEFAULT '{}', -- favourite treatments, product preferences
  life_events JSONB DEFAULT '{}', -- pregnancy, wedding, birthday
  communication_patterns JSONB DEFAULT '{}', -- preferred reply times, tone

  -- Behavioural
  avg_rebooking_days INTEGER, -- learned rebooking rhythm
  lateness_score NUMERIC(3,1) DEFAULT 0, -- avg minutes late (0 = on time)
  lateness_count INTEGER DEFAULT 0, -- how many times late
  no_show_count INTEGER DEFAULT 0,
  total_spend_cents INTEGER DEFAULT 0,
  total_visits INTEGER DEFAULT 0,

  -- Status
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'dormant', 'lost', 'new', 'vip')),
  last_visit_at TIMESTAMPTZ,
  next_expected_visit TIMESTAMPTZ, -- calculated from rebooking rhythm
  dormant_since TIMESTAMPTZ,

  -- Notes
  notes TEXT,

  -- Import tracking
  imported_from TEXT, -- 'fresha', 'timely', 'csv', etc.
  external_id TEXT, -- ID in the source system

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(beautician_id, email),
  UNIQUE(beautician_id, phone)
);

-- ============================================================
-- APPOINTMENTS
-- ============================================================
CREATE TABLE appointments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  treatment_id UUID NOT NULL REFERENCES treatments(id),

  -- Timing
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL, -- starts_at + duration + buffer
  duration_minutes INTEGER NOT NULL,
  buffer_minutes INTEGER DEFAULT 0,
  extra_padding_minutes INTEGER DEFAULT 0, -- added for late clients

  -- Status
  status TEXT DEFAULT 'confirmed' CHECK (status IN (
    'pending', 'confirmed', 'in_progress', 'completed',
    'cancelled_by_client', 'cancelled_by_beautician',
    'no_show', 'rescheduled'
  )),

  -- Pricing
  price_cents INTEGER NOT NULL,
  deposit_cents INTEGER DEFAULT 0,
  deposit_paid BOOLEAN DEFAULT false,
  no_show_fee_cents INTEGER DEFAULT 0,
  no_show_fee_charged BOOLEAN DEFAULT false,

  -- Source tracking
  booked_via TEXT DEFAULT 'booking_page' CHECK (booked_via IN (
    'booking_page', 'ai_front_desk', 'manual', 'voice_note',
    'comeback_engine', 'waitlist_fill'
  )),

  -- AI metadata
  ai_booked BOOLEAN DEFAULT false, -- was this booked by the AI?
  ai_action_id UUID, -- link to the AI action that created this

  -- Cancellation
  cancelled_at TIMESTAMPTZ,
  cancellation_reason TEXT,

  -- Client notes
  client_notes TEXT, -- notes from client at booking
  beautician_notes TEXT, -- private notes

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- WAITLIST
-- ============================================================
CREATE TABLE waitlist (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  treatment_id UUID NOT NULL REFERENCES treatments(id),

  -- Preferences
  preferred_days TEXT[] DEFAULT '{}', -- e.g. {"mon", "tue", "wed"}
  preferred_time_start TIME,
  preferred_time_end TIME,

  -- Status
  status TEXT DEFAULT 'waiting' CHECK (status IN ('waiting', 'offered', 'booked', 'expired')),
  offered_at TIMESTAMPTZ,
  responded_at TIMESTAMPTZ,

  -- Priority (AI-calculated based on likelihood to accept)
  priority_score NUMERIC(3,2) DEFAULT 0.50,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ -- auto-expire old waitlist entries
);

-- ============================================================
-- MESSAGES (WhatsApp, Instagram DMs, SMS)
-- ============================================================
CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  client_id UUID REFERENCES clients(id),

  -- Channel
  channel TEXT NOT NULL CHECK (channel IN ('whatsapp', 'instagram', 'sms', 'email', 'internal')),
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),

  -- Content
  content TEXT NOT NULL,
  media_url TEXT, -- for images, voice notes
  media_type TEXT, -- 'image', 'audio', 'video'

  -- AI handling
  ai_handled BOOLEAN DEFAULT false,
  ai_confidence NUMERIC(3,2), -- 0.00 to 1.00
  ai_intent TEXT, -- 'booking_request', 'price_enquiry', 'reschedule', 'general', etc.
  ai_response TEXT, -- what the AI drafted/sent
  tone_match_score NUMERIC(3,2), -- how well it matched beautician's tone

  -- Escalation
  escalated BOOLEAN DEFAULT false,
  escalated_reason TEXT,
  resolved BOOLEAN DEFAULT false,
  resolved_at TIMESTAMPTZ,

  -- External IDs
  external_message_id TEXT, -- WhatsApp/Instagram message ID

  -- Attribution
  digital_employee TEXT CHECK (digital_employee IN ('front_desk', 'calendar', 'comeback', 'content', 'money', 'scout')),

  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- TRANSACTIONS (income from bookings)
-- ============================================================
CREATE TABLE transactions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  appointment_id UUID REFERENCES appointments(id),

  -- Money
  amount_cents INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('payment', 'deposit', 'no_show_fee', 'refund', 'tip')),

  -- Stripe
  stripe_payment_intent_id TEXT,
  stripe_charge_id TEXT,
  payment_method TEXT CHECK (payment_method IN ('card_online', 'card_terminal', 'tap_to_pay', 'cash', 'bank_transfer')),

  -- Status
  status TEXT DEFAULT 'completed' CHECK (status IN ('pending', 'completed', 'failed', 'refunded')),

  -- Tax
  tax_year TEXT, -- e.g. "2025-26"

  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- EXPENSES (receipt scanning + manual entry)
-- ============================================================
CREATE TABLE expenses (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,

  amount_cents INTEGER NOT NULL,
  vendor TEXT,
  description TEXT,

  -- Categorisation
  category TEXT NOT NULL CHECK (category IN (
    'products', 'rent', 'training', 'travel', 'equipment',
    'insurance', 'marketing', 'software', 'utilities', 'other'
  )),

  -- Receipt
  receipt_image_url TEXT,
  ocr_data JSONB DEFAULT '{}', -- extracted data from Claude Vision
  ocr_confidence NUMERIC(3,2),

  -- Tax
  tax_year TEXT,
  tax_deductible BOOLEAN DEFAULT true,

  date DATE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- AI ACTIONS (everything the AI does, for the activity feed)
-- ============================================================
CREATE TABLE ai_actions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,

  -- What happened
  action_type TEXT NOT NULL CHECK (action_type IN (
    'message_replied', 'message_escalated', 'booking_created', 'booking_rescheduled',
    'cancellation_filled', 'waitlist_offered', 'client_reactivated', 'content_drafted',
    'content_posted', 'expense_logged', 'review_requested', 'campaign_drafted',
    'campaign_sent', 'price_suggestion', 'voice_note_processed', 'client_profile_updated',
    'dormant_detected', 'quiet_week_detected', 'contraindication_flagged',
    'appointment_padded', 'bundle_suggested'
  )),

  -- Who did it (digital employee)
  digital_employee TEXT NOT NULL CHECK (digital_employee IN (
    'front_desk', 'calendar', 'comeback', 'content', 'money', 'scout'
  )),

  -- Details
  summary TEXT NOT NULL, -- human-readable: "Booked Emma for Thursday 2pm brow lamination"
  details JSONB DEFAULT '{}', -- structured data about the action

  -- Confidence
  confidence NUMERIC(3,2),
  autonomous BOOLEAN DEFAULT true, -- did it act on its own or was it user-triggered?

  -- Links
  client_id UUID REFERENCES clients(id),
  appointment_id UUID REFERENCES appointments(id),
  message_id UUID REFERENCES messages(id),

  -- Outcome
  outcome TEXT CHECK (outcome IN ('success', 'pending', 'failed', 'escalated')),

  -- Notification
  notification_sent BOOLEAN DEFAULT false,
  notification_text TEXT, -- the push notification text

  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- CAMPAIGNS (comeback, rescue, weather, bank holiday)
-- ============================================================
CREATE TABLE campaigns (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,

  -- Type
  type TEXT NOT NULL CHECK (type IN (
    'reactivation', 'rescue', 'weather', 'bank_holiday', 'event', 'custom'
  )),
  trigger_reason TEXT, -- "quiet_week_detected", "heatwave_forecast", etc.

  -- Content
  name TEXT NOT NULL,
  message_template TEXT NOT NULL,

  -- Targeting
  target_client_ids UUID[] DEFAULT '{}',
  target_count INTEGER DEFAULT 0,

  -- Status
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'sending', 'sent', 'cancelled')),
  approved_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,

  -- Performance
  delivered_count INTEGER DEFAULT 0,
  opened_count INTEGER DEFAULT 0,
  responded_count INTEGER DEFAULT 0,
  booked_count INTEGER DEFAULT 0,
  revenue_recovered_cents INTEGER DEFAULT 0,

  -- Attribution
  digital_employee TEXT DEFAULT 'comeback',

  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- CONTENT (social media posts)
-- ============================================================
CREATE TABLE content_posts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,

  -- Content
  image_url TEXT,
  caption TEXT,
  hashtags TEXT[] DEFAULT '{}',
  platform TEXT NOT NULL CHECK (platform IN ('instagram', 'facebook', 'tiktok')),

  -- Type
  post_type TEXT DEFAULT 'before_after' CHECK (post_type IN (
    'before_after', 'last_minute_availability', 'promotion', 'testimonial', 'general'
  )),

  -- Status
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'scheduled', 'posted', 'failed')),
  approved_at TIMESTAMPTZ,
  scheduled_for TIMESTAMPTZ,
  posted_at TIMESTAMPTZ,

  -- Performance
  likes INTEGER DEFAULT 0,
  comments INTEGER DEFAULT 0,
  shares INTEGER DEFAULT 0,
  bookings_attributed INTEGER DEFAULT 0,

  -- External
  external_post_id TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- CLIENT INTELLIGENCE (rich profiles built by the agent loop)
-- ============================================================
CREATE TABLE client_intelligence (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,

  -- Rebooking
  rebooking_rhythm_days INTEGER, -- average days between visits
  rebooking_consistency NUMERIC(3,2), -- 0-1 how consistent they are
  preferred_days TEXT[] DEFAULT '{}',
  preferred_times TEXT[] DEFAULT '{}',

  -- Treatment patterns
  favourite_treatments UUID[] DEFAULT '{}',
  treatment_combos JSONB DEFAULT '{}', -- which treatments they combine
  avg_spend_cents INTEGER DEFAULT 0,
  price_sensitivity TEXT DEFAULT 'normal' CHECK (price_sensitivity IN ('low', 'normal', 'high')),

  -- Communication
  avg_response_time_minutes INTEGER,
  preferred_contact_time TEXT, -- 'morning', 'afternoon', 'evening'
  reactivation_responsiveness NUMERIC(3,2) DEFAULT 0.50, -- how likely to respond to comeback messages

  -- Life events
  is_pregnant BOOLEAN DEFAULT false,
  wedding_date DATE,
  birthday DATE,

  -- Flags
  contraindications TEXT[] DEFAULT '{}',

  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- VOICE NOTES
-- ============================================================
CREATE TABLE voice_notes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,

  audio_url TEXT NOT NULL,
  duration_seconds INTEGER,

  -- Transcription
  transcript TEXT,
  transcribed_at TIMESTAMPTZ,

  -- Extracted actions
  extracted_actions JSONB DEFAULT '[]', -- array of actions the AI identified
  actions_executed BOOLEAN DEFAULT false,

  -- Links
  ai_action_ids UUID[] DEFAULT '{}', -- the AI actions created from this voice note

  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- INDEXES
-- ============================================================

-- Appointments: fast lookups by date range and status
CREATE INDEX idx_appointments_beautician_date ON appointments(beautician_id, starts_at);
CREATE INDEX idx_appointments_status ON appointments(status);
CREATE INDEX idx_appointments_client ON appointments(client_id);

-- Clients: dormant detection, lifecycle
CREATE INDEX idx_clients_beautician_status ON clients(beautician_id, status);
CREATE INDEX idx_clients_last_visit ON clients(beautician_id, last_visit_at);
CREATE INDEX idx_clients_next_expected ON clients(beautician_id, next_expected_visit);

-- Messages: AI handling queue
CREATE INDEX idx_messages_unresolved ON messages(beautician_id, ai_handled, escalated) WHERE NOT ai_handled OR escalated;
CREATE INDEX idx_messages_created ON messages(beautician_id, created_at DESC);

-- AI Actions: activity feed
CREATE INDEX idx_ai_actions_feed ON ai_actions(beautician_id, created_at DESC);
CREATE INDEX idx_ai_actions_employee ON ai_actions(beautician_id, digital_employee, created_at DESC);

-- Transactions: tax reports
CREATE INDEX idx_transactions_tax ON transactions(beautician_id, tax_year);
CREATE INDEX idx_transactions_date ON transactions(beautician_id, created_at);

-- Expenses: tax reports
CREATE INDEX idx_expenses_tax ON expenses(beautician_id, tax_year);
CREATE INDEX idx_expenses_date ON expenses(beautician_id, date);

-- Waitlist: matching
CREATE INDEX idx_waitlist_active ON waitlist(beautician_id, status) WHERE status = 'waiting';

-- Campaigns: performance
CREATE INDEX idx_campaigns_beautician ON campaigns(beautician_id, created_at DESC);

-- Content: queue
CREATE INDEX idx_content_queue ON content_posts(beautician_id, status, scheduled_for);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE beauticians ENABLE ROW LEVEL SECURITY;
ALTER TABLE treatments ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE waitlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_intelligence ENABLE ROW LEVEL SECURITY;
ALTER TABLE voice_notes ENABLE ROW LEVEL SECURITY;

-- Beauticians can only see their own data
CREATE POLICY beautician_own_data ON beauticians
  FOR ALL USING (auth_id = auth.uid());

-- All child tables: beautician can only access rows matching their beautician_id
CREATE POLICY treatments_own ON treatments
  FOR ALL USING (beautician_id IN (SELECT id FROM beauticians WHERE auth_id = auth.uid()));

CREATE POLICY clients_own ON clients
  FOR ALL USING (beautician_id IN (SELECT id FROM beauticians WHERE auth_id = auth.uid()));

CREATE POLICY appointments_own ON appointments
  FOR ALL USING (beautician_id IN (SELECT id FROM beauticians WHERE auth_id = auth.uid()));

CREATE POLICY waitlist_own ON waitlist
  FOR ALL USING (beautician_id IN (SELECT id FROM beauticians WHERE auth_id = auth.uid()));

CREATE POLICY messages_own ON messages
  FOR ALL USING (beautician_id IN (SELECT id FROM beauticians WHERE auth_id = auth.uid()));

CREATE POLICY transactions_own ON transactions
  FOR ALL USING (beautician_id IN (SELECT id FROM beauticians WHERE auth_id = auth.uid()));

CREATE POLICY expenses_own ON expenses
  FOR ALL USING (beautician_id IN (SELECT id FROM beauticians WHERE auth_id = auth.uid()));

CREATE POLICY ai_actions_own ON ai_actions
  FOR ALL USING (beautician_id IN (SELECT id FROM beauticians WHERE auth_id = auth.uid()));

CREATE POLICY campaigns_own ON campaigns
  FOR ALL USING (beautician_id IN (SELECT id FROM beauticians WHERE auth_id = auth.uid()));

CREATE POLICY content_posts_own ON content_posts
  FOR ALL USING (beautician_id IN (SELECT id FROM beauticians WHERE auth_id = auth.uid()));

CREATE POLICY client_intelligence_own ON client_intelligence
  FOR ALL USING (beautician_id IN (SELECT id FROM beauticians WHERE auth_id = auth.uid()));

CREATE POLICY voice_notes_own ON voice_notes
  FOR ALL USING (beautician_id IN (SELECT id FROM beauticians WHERE auth_id = auth.uid()));

-- ============================================================
-- UPDATED_AT TRIGGER
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_updated_at BEFORE UPDATE ON beauticians
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON treatments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON clients
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
