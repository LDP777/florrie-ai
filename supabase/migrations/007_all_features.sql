-- Florrie.ai — Migration 007: All Features (production readiness)
-- Creates every missing table needed to light up all Hub features.
-- Created: 2026-03-27

-- ============================================================
-- DAILY CHECKLISTS
-- ============================================================
CREATE TABLE IF NOT EXISTS daily_checklists (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  list_type TEXT NOT NULL DEFAULT 'opening' CHECK (list_type IN ('opening', 'closing', 'custom')),
  label TEXT NOT NULL,
  done BOOLEAN DEFAULT false,
  sort_order INTEGER DEFAULT 0,
  due_date DATE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- CONSULTATIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS consultations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  treatment_id UUID REFERENCES treatments(id),
  appointment_id UUID REFERENCES appointments(id),
  status TEXT DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled', 'no_show')),
  notes TEXT,
  medical_notes TEXT,
  photos JSONB DEFAULT '[]',
  consent_given BOOLEAN DEFAULT false,
  consent_at TIMESTAMPTZ,
  scheduled_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- PATCH TESTS
-- ============================================================
CREATE TABLE IF NOT EXISTS patch_tests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  treatment_id UUID REFERENCES treatments(id),
  product_used TEXT,
  test_date DATE NOT NULL,
  result TEXT DEFAULT 'pending' CHECK (result IN ('pending', 'pass', 'fail', 'reaction')),
  reaction_notes TEXT,
  photo_url TEXT,
  expires_at DATE, -- patch tests typically valid for 6 months
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- AFTERCARE MESSAGES
-- ============================================================
CREATE TABLE IF NOT EXISTS aftercare_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  treatment_id UUID REFERENCES treatments(id),
  name TEXT NOT NULL,
  message TEXT NOT NULL,
  send_after_hours INTEGER DEFAULT 24, -- hours after appointment
  channel TEXT DEFAULT 'email' CHECK (channel IN ('email', 'whatsapp', 'sms')),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- PACKAGES (bundles / courses)
-- ============================================================
CREATE TABLE IF NOT EXISTS packages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  treatment_ids UUID[] DEFAULT '{}',
  sessions_total INTEGER DEFAULT 1,
  price_cents INTEGER NOT NULL,
  saving_cents INTEGER DEFAULT 0, -- how much cheaper vs buying individually
  validity_days INTEGER DEFAULT 365,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Client package purchases
CREATE TABLE IF NOT EXISTS client_packages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  package_id UUID NOT NULL REFERENCES packages(id),
  sessions_used INTEGER DEFAULT 0,
  sessions_total INTEGER NOT NULL,
  purchased_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'completed', 'expired', 'cancelled')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- ADD-ONS
-- ============================================================
CREATE TABLE IF NOT EXISTS add_ons (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  price_cents INTEGER NOT NULL,
  duration_minutes INTEGER DEFAULT 0,
  compatible_treatment_ids UUID[] DEFAULT '{}', -- empty = compatible with all
  is_active BOOLEAN DEFAULT true,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- GIFT VOUCHERS
-- ============================================================
CREATE TABLE IF NOT EXISTS gift_vouchers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  remaining_cents INTEGER NOT NULL,
  purchaser_name TEXT,
  purchaser_email TEXT,
  recipient_name TEXT,
  recipient_email TEXT,
  message TEXT,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'redeemed', 'expired', 'cancelled')),
  purchased_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  redeemed_at TIMESTAMPTZ,
  redeemed_by UUID REFERENCES clients(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- CLIENT MEMBERSHIPS
-- ============================================================
CREATE TABLE IF NOT EXISTS client_memberships (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  price_cents INTEGER NOT NULL, -- monthly price
  benefits JSONB DEFAULT '[]', -- e.g. [{"type": "discount", "value": 10}, {"type": "free_treatment", "treatment_id": "..."}]
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS membership_subscriptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  membership_id UUID NOT NULL REFERENCES client_memberships(id),
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'paused', 'cancelled', 'expired')),
  started_at TIMESTAMPTZ DEFAULT NOW(),
  next_billing_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- LOYALTY
-- ============================================================
CREATE TABLE IF NOT EXISTS loyalty_config (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  beautician_id UUID UNIQUE NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  points_per_pound INTEGER DEFAULT 1, -- 1 point per £1 spent
  reward_threshold INTEGER DEFAULT 100, -- points needed for reward
  reward_type TEXT DEFAULT 'discount' CHECK (reward_type IN ('discount', 'free_treatment', 'gift')),
  reward_value_cents INTEGER DEFAULT 1000, -- £10 reward
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS loyalty_points (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  points INTEGER NOT NULL,
  reason TEXT NOT NULL, -- 'appointment', 'referral', 'review', 'manual', 'redeemed'
  appointment_id UUID REFERENCES appointments(id),
  balance_after INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- REFERRALS
-- ============================================================
CREATE TABLE IF NOT EXISTS referrals (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  referrer_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  referred_id UUID REFERENCES clients(id),
  referred_name TEXT,
  referred_email TEXT,
  referred_phone TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'booked', 'completed', 'rewarded')),
  referrer_reward_cents INTEGER DEFAULT 0,
  referred_reward_cents INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- ============================================================
-- REVENUE GOALS
-- ============================================================
CREATE TABLE IF NOT EXISTS revenue_goals (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  period TEXT NOT NULL CHECK (period IN ('weekly', 'monthly', 'quarterly', 'yearly')),
  target_cents INTEGER NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- MESSAGE TEMPLATES
-- ============================================================
CREATE TABLE IF NOT EXISTS message_templates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT DEFAULT 'general' CHECK (category IN (
    'booking_confirmation', 'reminder', 'aftercare', 'rebook',
    'cancellation', 'review_request', 'promotion', 'general'
  )),
  content TEXT NOT NULL,
  channel TEXT DEFAULT 'whatsapp' CHECK (channel IN ('whatsapp', 'sms', 'email')),
  variables TEXT[] DEFAULT '{}', -- e.g. {"{client_name}", "{treatment}", "{date}"}
  is_active BOOLEAN DEFAULT true,
  use_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- AUTOMATION RULES
-- ============================================================
CREATE TABLE IF NOT EXISTS automation_rules (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN (
    'booking_created', 'booking_cancelled', 'appointment_completed',
    'client_dormant', 'no_show', 'review_received', 'birthday',
    'rebook_due', 'custom'
  )),
  action_type TEXT NOT NULL CHECK (action_type IN (
    'send_message', 'send_email', 'add_tag', 'remove_tag',
    'update_status', 'create_task', 'notify_beautician'
  )),
  trigger_config JSONB DEFAULT '{}', -- e.g. {"days_dormant": 30}
  action_config JSONB DEFAULT '{}', -- e.g. {"template_id": "...", "channel": "whatsapp"}
  is_active BOOLEAN DEFAULT true,
  last_triggered_at TIMESTAMPTZ,
  trigger_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- POLICIES
-- ============================================================
CREATE TABLE IF NOT EXISTS policies (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('cancellation', 'no_show', 'deposit', 'late', 'health', 'privacy', 'custom')),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  is_active BOOLEAN DEFAULT true,
  show_on_booking BOOLEAN DEFAULT false,
  require_acceptance BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- INTAKE / CONSENT FORMS
-- ============================================================
CREATE TABLE IF NOT EXISTS intake_forms (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  fields JSONB NOT NULL DEFAULT '[]', -- array of field definitions
  treatment_ids UUID[] DEFAULT '{}', -- linked treatments (empty = all)
  is_active BOOLEAN DEFAULT true,
  require_before_booking BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS form_submissions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  form_id UUID NOT NULL REFERENCES intake_forms(id),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  appointment_id UUID REFERENCES appointments(id),
  responses JSONB NOT NULL DEFAULT '{}',
  submitted_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- HOURS EXCEPTIONS (holidays, closures, special hours)
-- ============================================================
CREATE TABLE IF NOT EXISTS hours_exceptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  is_closed BOOLEAN DEFAULT true,
  custom_start TIME,
  custom_end TIME,
  reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- CLIENT TAGS
-- ============================================================
CREATE TABLE IF NOT EXISTS client_tags (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT DEFAULT '#C76B8A',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(beautician_id, name)
);

CREATE TABLE IF NOT EXISTS client_tag_assignments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  tag_id UUID NOT NULL REFERENCES client_tags(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(client_id, tag_id)
);

-- ============================================================
-- REVIEWS
-- ============================================================
CREATE TABLE IF NOT EXISTS reviews (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  client_id UUID REFERENCES clients(id),
  appointment_id UUID REFERENCES appointments(id),
  platform TEXT DEFAULT 'florrie' CHECK (platform IN ('florrie', 'google', 'instagram', 'facebook', 'manual')),
  rating INTEGER CHECK (rating >= 1 AND rating <= 5),
  comment TEXT,
  response TEXT, -- beautician's reply
  responded_at TIMESTAMPTZ,
  is_public BOOLEAN DEFAULT true,
  external_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- END OF DAY REPORTS
-- ============================================================
CREATE TABLE IF NOT EXISTS end_of_day_reports (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  cash_total_cents INTEGER DEFAULT 0,
  card_total_cents INTEGER DEFAULT 0,
  total_clients INTEGER DEFAULT 0,
  total_appointments INTEGER DEFAULT 0,
  notes TEXT,
  tips_cents INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(beautician_id, date)
);

-- ============================================================
-- CLIENT PORTAL SETTINGS
-- ============================================================
CREATE TABLE IF NOT EXISTS portal_settings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  beautician_id UUID UNIQUE NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  allow_self_booking BOOLEAN DEFAULT true,
  allow_rescheduling BOOLEAN DEFAULT true,
  allow_cancellation BOOLEAN DEFAULT true,
  cancellation_window_hours INTEGER DEFAULT 24,
  show_prices BOOLEAN DEFAULT true,
  show_reviews BOOLEAN DEFAULT true,
  custom_welcome TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- REBOOK REMINDERS CONFIG
-- ============================================================
CREATE TABLE IF NOT EXISTS rebook_reminders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  treatment_id UUID REFERENCES treatments(id),
  remind_after_days INTEGER NOT NULL DEFAULT 28,
  message_template TEXT,
  channel TEXT DEFAULT 'whatsapp' CHECK (channel IN ('whatsapp', 'sms', 'email')),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- RLS POLICIES (for all new tables)
-- ============================================================
ALTER TABLE daily_checklists ENABLE ROW LEVEL SECURITY;
ALTER TABLE consultations ENABLE ROW LEVEL SECURITY;
ALTER TABLE patch_tests ENABLE ROW LEVEL SECURITY;
ALTER TABLE aftercare_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE add_ons ENABLE ROW LEVEL SECURITY;
ALTER TABLE gift_vouchers ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE loyalty_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE loyalty_points ENABLE ROW LEVEL SECURITY;
ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;
ALTER TABLE revenue_goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE intake_forms ENABLE ROW LEVEL SECURITY;
ALTER TABLE form_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE hours_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_tag_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE end_of_day_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE rebook_reminders ENABLE ROW LEVEL SECURITY;

-- Standard RLS: beautician can only access their own data
CREATE POLICY daily_checklists_own ON daily_checklists FOR ALL USING (beautician_id IN (SELECT id FROM beauticians WHERE auth_id = auth.uid()));
CREATE POLICY consultations_own ON consultations FOR ALL USING (beautician_id IN (SELECT id FROM beauticians WHERE auth_id = auth.uid()));
CREATE POLICY patch_tests_own ON patch_tests FOR ALL USING (beautician_id IN (SELECT id FROM beauticians WHERE auth_id = auth.uid()));
CREATE POLICY aftercare_messages_own ON aftercare_messages FOR ALL USING (beautician_id IN (SELECT id FROM beauticians WHERE auth_id = auth.uid()));
CREATE POLICY packages_own ON packages FOR ALL USING (beautician_id IN (SELECT id FROM beauticians WHERE auth_id = auth.uid()));
CREATE POLICY client_packages_own ON client_packages FOR ALL USING (beautician_id IN (SELECT id FROM beauticians WHERE auth_id = auth.uid()));
CREATE POLICY add_ons_own ON add_ons FOR ALL USING (beautician_id IN (SELECT id FROM beauticians WHERE auth_id = auth.uid()));
CREATE POLICY gift_vouchers_own ON gift_vouchers FOR ALL USING (beautician_id IN (SELECT id FROM beauticians WHERE auth_id = auth.uid()));
CREATE POLICY client_memberships_own ON client_memberships FOR ALL USING (beautician_id IN (SELECT id FROM beauticians WHERE auth_id = auth.uid()));
CREATE POLICY membership_subscriptions_own ON membership_subscriptions FOR ALL USING (beautician_id IN (SELECT id FROM beauticians WHERE auth_id = auth.uid()));
CREATE POLICY loyalty_config_own ON loyalty_config FOR ALL USING (beautician_id IN (SELECT id FROM beauticians WHERE auth_id = auth.uid()));
CREATE POLICY loyalty_points_own ON loyalty_points FOR ALL USING (beautician_id IN (SELECT id FROM beauticians WHERE auth_id = auth.uid()));
CREATE POLICY referrals_own ON referrals FOR ALL USING (beautician_id IN (SELECT id FROM beauticians WHERE auth_id = auth.uid()));
CREATE POLICY revenue_goals_own ON revenue_goals FOR ALL USING (beautician_id IN (SELECT id FROM beauticians WHERE auth_id = auth.uid()));
CREATE POLICY message_templates_own ON message_templates FOR ALL USING (beautician_id IN (SELECT id FROM beauticians WHERE auth_id = auth.uid()));
CREATE POLICY automation_rules_own ON automation_rules FOR ALL USING (beautician_id IN (SELECT id FROM beauticians WHERE auth_id = auth.uid()));
CREATE POLICY policies_own ON policies FOR ALL USING (beautician_id IN (SELECT id FROM beauticians WHERE auth_id = auth.uid()));
CREATE POLICY intake_forms_own ON intake_forms FOR ALL USING (beautician_id IN (SELECT id FROM beauticians WHERE auth_id = auth.uid()));
CREATE POLICY form_submissions_own ON form_submissions FOR ALL USING (beautician_id IN (SELECT id FROM beauticians WHERE auth_id = auth.uid()));
CREATE POLICY hours_exceptions_own ON hours_exceptions FOR ALL USING (beautician_id IN (SELECT id FROM beauticians WHERE auth_id = auth.uid()));
CREATE POLICY client_tags_own ON client_tags FOR ALL USING (beautician_id IN (SELECT id FROM beauticians WHERE auth_id = auth.uid()));
CREATE POLICY client_tag_assignments_own ON client_tag_assignments FOR ALL USING (
  client_id IN (SELECT id FROM clients WHERE beautician_id IN (SELECT id FROM beauticians WHERE auth_id = auth.uid()))
);
CREATE POLICY reviews_own ON reviews FOR ALL USING (beautician_id IN (SELECT id FROM beauticians WHERE auth_id = auth.uid()));
CREATE POLICY end_of_day_reports_own ON end_of_day_reports FOR ALL USING (beautician_id IN (SELECT id FROM beauticians WHERE auth_id = auth.uid()));
CREATE POLICY portal_settings_own ON portal_settings FOR ALL USING (beautician_id IN (SELECT id FROM beauticians WHERE auth_id = auth.uid()));
CREATE POLICY rebook_reminders_own ON rebook_reminders FOR ALL USING (beautician_id IN (SELECT id FROM beauticians WHERE auth_id = auth.uid()));

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX idx_daily_checklists_date ON daily_checklists(beautician_id, date);
CREATE INDEX idx_consultations_client ON consultations(beautician_id, client_id);
CREATE INDEX idx_patch_tests_client ON patch_tests(beautician_id, client_id);
CREATE INDEX idx_patch_tests_expiry ON patch_tests(expires_at) WHERE result = 'pass';
CREATE INDEX idx_packages_active ON packages(beautician_id) WHERE is_active = true;
CREATE INDEX idx_gift_vouchers_code ON gift_vouchers(beautician_id, code);
CREATE INDEX idx_loyalty_points_client ON loyalty_points(beautician_id, client_id);
CREATE INDEX idx_referrals_referrer ON referrals(beautician_id, referrer_id);
CREATE INDEX idx_revenue_goals_period ON revenue_goals(beautician_id, start_date, end_date);
CREATE INDEX idx_message_templates_cat ON message_templates(beautician_id, category);
CREATE INDEX idx_automation_rules_trigger ON automation_rules(beautician_id, trigger_type) WHERE is_active = true;
CREATE INDEX idx_hours_exceptions_date ON hours_exceptions(beautician_id, date);
CREATE INDEX idx_client_tags_beautician ON client_tags(beautician_id);
CREATE INDEX idx_reviews_beautician ON reviews(beautician_id, created_at DESC);
CREATE INDEX idx_end_of_day_date ON end_of_day_reports(beautician_id, date);

-- Updated_at triggers for tables that need them
CREATE TRIGGER set_updated_at BEFORE UPDATE ON daily_checklists FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON consultations FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON patch_tests FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON aftercare_messages FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON packages FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON add_ons FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON client_memberships FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON loyalty_config FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON message_templates FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON automation_rules FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON policies FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON intake_forms FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON portal_settings FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON rebook_reminders FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON revenue_goals FOR EACH ROW EXECUTE FUNCTION update_updated_at();
