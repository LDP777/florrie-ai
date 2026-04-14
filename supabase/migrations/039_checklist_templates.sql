-- Migration 039: checklist_templates
-- Stores per-beautician saved checklist templates (opening/closing).
-- Used by DailyChecklist.jsx to persist custom task lists across days.

CREATE TABLE IF NOT EXISTS checklist_templates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  beautician_id   uuid NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  type            text NOT NULL CHECK (type IN ('opening', 'closing')),
  label           text NOT NULL,
  icon            text NOT NULL DEFAULT 'check_circle',
  sort_order      integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS checklist_templates_beautician_idx
  ON checklist_templates (beautician_id, type, sort_order);

-- RLS
ALTER TABLE checklist_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Beauticians manage own checklist templates"
  ON checklist_templates
  FOR ALL
  USING (beautician_id = auth.uid())
  WITH CHECK (beautician_id = auth.uid());
