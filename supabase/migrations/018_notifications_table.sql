-- Florrie.ai — Notifications table
-- In-app notification feed: bookings, payments, AI events, client activity, system alerts.
-- Rows inserted by backend event handlers; frontend reads via fetchRows().
-- Created: 2026-04-02

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,

  category TEXT NOT NULL CHECK (category IN ('booking', 'payment', 'ai', 'client', 'system')),
  type TEXT NOT NULL,          -- e.g. booking_confirmed, payment_received, auto_reply, escalation
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  read BOOLEAN DEFAULT false,
  action_url TEXT,             -- deep link within the app, e.g. /calendar, /money

  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_notifications_beautician ON notifications(beautician_id, created_at DESC);
CREATE INDEX idx_notifications_unread ON notifications(beautician_id) WHERE read = false;

-- RLS
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Beauticians see own notifications"
  ON notifications FOR SELECT
  USING (beautician_id = auth.uid() OR beautician_id IN (
    SELECT id FROM beauticians WHERE auth_id = auth.uid()
  ));

CREATE POLICY "Beauticians update own notifications"
  ON notifications FOR UPDATE
  USING (beautician_id IN (
    SELECT id FROM beauticians WHERE auth_id = auth.uid()
  ));
