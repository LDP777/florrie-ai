-- ============================================================
-- 009: Consultation Forms System
-- Customisable consent/consultation forms with SMS delivery
-- ============================================================

-- Add deposit_percent to treatments (percentage-based deposits)
ALTER TABLE treatments ADD COLUMN IF NOT EXISTS deposit_percent integer DEFAULT 0;
-- deposit_percent = 50 means 50% of price_cents taken as deposit
-- If deposit_percent > 0, it overrides deposit_cents at booking time

-- Link treatments to specific consultation forms
ALTER TABLE treatments ADD COLUMN IF NOT EXISTS consultation_form_id uuid REFERENCES consultation_forms(id) ON DELETE SET NULL;
-- If null, falls back to beautician's default form (if any)

-- ── Consultation form templates ─────────────────────────────
CREATE TABLE IF NOT EXISTS consultation_forms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  beautician_id uuid NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  name text NOT NULL,                    -- e.g. "Brow Consultation Form"
  consent_text text,                     -- big consent paragraph shown at the bottom
  is_default boolean DEFAULT false,      -- if true, auto-sent to all first-time clients
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_consultation_forms_beautician ON consultation_forms(beautician_id);

-- ── Form fields (questions) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS consultation_form_fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  form_id uuid NOT NULL REFERENCES consultation_forms(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('text', 'yes_no', 'multi_select', 'single_select', 'checkbox', 'text_block', 'signature')),
  label text NOT NULL,                   -- question text or text block content
  options jsonb DEFAULT '[]'::jsonb,     -- for multi_select/single_select: ["Option A", "Option B"]
  required boolean DEFAULT false,
  sort_order integer DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_consultation_fields_form ON consultation_form_fields(form_id);

-- ── Client form responses ───────────────────────────────────
CREATE TABLE IF NOT EXISTS consultation_responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  form_id uuid NOT NULL REFERENCES consultation_forms(id) ON DELETE CASCADE,
  beautician_id uuid NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  client_id uuid REFERENCES clients(id) ON DELETE SET NULL,
  appointment_id uuid REFERENCES appointments(id) ON DELETE SET NULL,
  token text UNIQUE NOT NULL,            -- public access token (UUID v4)
  answers jsonb DEFAULT '{}'::jsonb,     -- { field_id: value } — value is string, boolean, or string[]
  signature_data text,                   -- base64 signature image
  status text DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'expired')),
  completed_at timestamptz,
  expires_at timestamptz,                -- auto-expire after 7 days
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_consultation_responses_token ON consultation_responses(token);
CREATE INDEX IF NOT EXISTS idx_consultation_responses_client ON consultation_responses(client_id);
CREATE INDEX IF NOT EXISTS idx_consultation_responses_appointment ON consultation_responses(appointment_id);

-- ── RLS policies ────────────────────────────────────────────
ALTER TABLE consultation_forms ENABLE ROW LEVEL SECURITY;
ALTER TABLE consultation_form_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE consultation_responses ENABLE ROW LEVEL SECURITY;

-- Beauticians can manage their own forms
CREATE POLICY consultation_forms_owner ON consultation_forms
  FOR ALL USING (beautician_id = auth.uid());

-- Fields inherit form ownership
CREATE POLICY consultation_fields_owner ON consultation_form_fields
  FOR ALL USING (form_id IN (SELECT id FROM consultation_forms WHERE beautician_id = auth.uid()));

-- Responses: beautician can read their own, public can insert via token
CREATE POLICY consultation_responses_owner ON consultation_responses
  FOR ALL USING (beautician_id = auth.uid());

-- Service role bypasses RLS (backend uses service key)
