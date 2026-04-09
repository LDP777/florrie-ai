-- Migration 017: Full payment system expansion
-- Adds: payment_links table, no-show fee columns, payment_method on transactions,
--        deposit_percent + consultation_form_id on treatments (referenced in code but missing),
--        appointment_add_ons table (referenced in code but missing).

-- ═══════════════════════════════════════════════
-- Payment Links — ad-hoc payment requests sent by beauticians
-- ═══════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS payment_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  client_id UUID REFERENCES clients(id) ON DELETE SET NULL,
  appointment_id UUID REFERENCES appointments(id) ON DELETE SET NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 50),
  description TEXT,
  stripe_session_id TEXT,
  checkout_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'expired', 'cancelled')),
  paid_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_payment_links_beautician ON payment_links(beautician_id);
CREATE INDEX idx_payment_links_status ON payment_links(status) WHERE status = 'pending';

-- RLS
ALTER TABLE payment_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Beauticians manage own payment links"
  ON payment_links FOR ALL
  USING (beautician_id = auth.uid())
  WITH CHECK (beautician_id = auth.uid());

-- ═══════════════════════════════════════════════
-- Appointments — no-show fee columns
-- ═══════════════════════════════════════════════

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS payment_type TEXT DEFAULT 'deposit' CHECK (payment_type IN ('deposit', 'full'));
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS no_show_fee_cents INTEGER DEFAULT 0;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS no_show_fee_charged BOOLEAN DEFAULT FALSE;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS no_show_fee_payment_intent TEXT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS no_showed_at TIMESTAMPTZ;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;

-- ═══════════════════════════════════════════════
-- Treatments — missing columns referenced in code
-- ═══════════════════════════════════════════════

ALTER TABLE treatments ADD COLUMN IF NOT EXISTS deposit_percent NUMERIC DEFAULT 0;
ALTER TABLE treatments ADD COLUMN IF NOT EXISTS consultation_form_id UUID;

-- ═══════════════════════════════════════════════
-- Transactions — payment_method + client_id columns
-- ═══════════════════════════════════════════════

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS payment_method TEXT DEFAULT 'card';
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES clients(id) ON DELETE SET NULL;

-- ═══════════════════════════════════════════════
-- Appointment Add-Ons join table
-- ═══════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS appointment_add_ons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id UUID NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  add_on_id UUID NOT NULL REFERENCES add_ons(id) ON DELETE CASCADE,
  price_cents INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_appointment_add_ons_appt ON appointment_add_ons(appointment_id);

-- RLS (inherits through appointment ownership)
ALTER TABLE appointment_add_ons ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Beauticians see own appointment add-ons"
  ON appointment_add_ons FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM appointments a
      WHERE a.id = appointment_add_ons.appointment_id
      AND a.beautician_id = auth.uid()
    )
  );

-- Service role can insert (booking endpoint uses service key)
CREATE POLICY "Service role inserts appointment add-ons"
  ON appointment_add_ons FOR INSERT
  WITH CHECK (true);
