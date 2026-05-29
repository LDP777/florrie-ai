-- 053_clients_whatsapp_id_unique.sql
-- Audit 2026-05-29 (M4).
-- Prevent duplicate client rows for the same WhatsApp contact under one
-- beautician (e.g. a client deleted then recreated during migration tests).
-- Partial: only enforced where whatsapp_id is set, so the many NULLs are fine.
--
-- NOTE: if existing rows already contain duplicates this will fail; dedupe
-- first, then re-run. It is intentionally not wrapped so the error surfaces.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_clients_beautician_whatsapp_id
  ON clients (beautician_id, whatsapp_id)
  WHERE whatsapp_id IS NOT NULL;
