-- 072_treatment_color.sql
-- Per-treatment colour so each service reads as a distinct block on the calendar.
-- Nullable: when null the UI auto-assigns a stable colour from the palette,
-- so every treatment looks distinct even before Ellie picks her own.
ALTER TABLE treatments ADD COLUMN IF NOT EXISTS color TEXT;
