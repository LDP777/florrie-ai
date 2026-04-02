-- Referral tracking system.
-- Beauticians share a referral link/code. When a new client books through it,
-- we log the referral. Rewards are issued after the referred client's first completed appointment.

CREATE TABLE IF NOT EXISTS referrals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  referrer_client_id UUID REFERENCES clients(id) ON DELETE SET NULL,
  referrer_name TEXT,
  referred_client_id UUID REFERENCES clients(id) ON DELETE SET NULL,
  referred_name TEXT,
  referral_code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'booked', 'completed', 'rewarded', 'expired')),
  reward_type TEXT DEFAULT 'discount'
    CHECK (reward_type IN ('discount', 'free_addon', 'credit', 'none')),
  reward_value_cents INT DEFAULT 0,
  reward_issued_at TIMESTAMPTZ,
  appointment_id UUID REFERENCES appointments(id) ON DELETE SET NULL,
  source TEXT DEFAULT 'link',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Each beautician has a referral configuration
ALTER TABLE beauticians
  ADD COLUMN IF NOT EXISTS referral_enabled BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS referral_reward_type TEXT DEFAULT 'discount',
  ADD COLUMN IF NOT EXISTS referral_reward_value_cents INT DEFAULT 500,
  ADD COLUMN IF NOT EXISTS referral_code TEXT;

-- Unique referral codes
CREATE UNIQUE INDEX IF NOT EXISTS idx_referrals_code
  ON referrals (referral_code);

-- Per-beautician referrals
CREATE INDEX IF NOT EXISTS idx_referrals_beautician
  ON referrals (beautician_id, created_at DESC);

-- Per-referrer stats
CREATE INDEX IF NOT EXISTS idx_referrals_referrer
  ON referrals (beautician_id, referrer_client_id);

-- Unique referral code per beautician
CREATE UNIQUE INDEX IF NOT EXISTS idx_beautician_referral_code
  ON beauticians (referral_code) WHERE referral_code IS NOT NULL;

-- Google Place ID for review links
ALTER TABLE beauticians
  ADD COLUMN IF NOT EXISTS google_place_id TEXT;

-- RLS
ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;

CREATE POLICY referrals_own ON referrals
  FOR ALL USING (beautician_id = auth.uid());

-- Updated_at trigger
CREATE OR REPLACE TRIGGER referrals_updated_at
  BEFORE UPDATE ON referrals
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();
