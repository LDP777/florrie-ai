-- ============================================================================
-- Ellie pilot — populate business_name so WhatsApp /preflight passes
-- ============================================================================
--
-- WHY THIS EXISTS
-- backend/src/routes/whatsapp-config.js:394-402 rejects /preflight with
-- "Set your business name first" if beauticians.business_name is NULL or
-- empty. Without this row populated, Ellie's WhatsApp connect flow fails
-- with a confusing error before Meta is ever called.
--
-- WHEN TO RUN
-- Before Ellie attempts her WhatsApp connect flow for the first time.
--
-- WHERE TO RUN
-- Supabase SQL Editor (Florrie project). Paste the whole file. Hit Run.
--
-- ⚠️ BEFORE RUNNING — replace the email below with Ellie's real account email.
-- If you don't know it, run this query first to find her row:
--
--     SELECT id, email, first_name, last_name, business_name
--     FROM beauticians
--     WHERE first_name ILIKE 'ellie%' OR last_name ILIKE 'ellie%';
--
-- WHAT IT DOES
-- 1. Looks up Ellie's beautician row by email.
-- 2. Sets business_name to "Ellindigo Brows & Beauty" (matches ellie-seed-data.json).
-- 3. Idempotent — safe to rerun, only updates if business_name is NULL or empty.
-- ============================================================================

DO $$
DECLARE
  v_email TEXT := 'REPLACE_WITH_ELLIE_EMAIL@example.com';  -- ⚠️ EDIT THIS
  v_name  TEXT := 'Ellindigo Brows & Beauty';
  v_id    UUID;
  v_existing TEXT;
BEGIN
  SELECT id, business_name INTO v_id, v_existing
  FROM beauticians
  WHERE email = v_email
  LIMIT 1;

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'No beautician found with email %. Edit v_email at the top of this file.', v_email;
  END IF;

  IF v_existing IS NOT NULL AND v_existing <> '' THEN
    RAISE NOTICE 'business_name already set for % → "%". No change.', v_email, v_existing;
  ELSE
    UPDATE beauticians
    SET business_name = v_name,
        updated_at = NOW()
    WHERE id = v_id;
    RAISE NOTICE 'Updated beautician % → business_name = "%"', v_id, v_name;
  END IF;
END $$;

-- ============================================================================
-- Verify
-- ============================================================================
-- SELECT id, email, first_name, last_name, business_name
-- FROM beauticians
-- WHERE email = 'REPLACE_WITH_ELLIE_EMAIL@example.com';
