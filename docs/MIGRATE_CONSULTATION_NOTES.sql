-- ═══════════════════════════════════════════════════════════════════════════
-- CONSULTATION ANSWERS STORED IN appointments.client_notes
--
-- WHY THIS FILE EXISTS
-- Found while surfacing consultation forms (the client profile and appointment
-- sheet that finally read consultation_responses). The public booking page has
-- always stored the consultation answers it collects as a JSON string inside
-- appointments.client_notes:
--
--     JSON.stringify({ notes, consultation })
--
-- That path never touched consultation_responses, so those answers are
-- invisible to every consultation surface, and client_notes was being pasted
-- verbatim into a Google Calendar event body and into the unauthenticated iCal
-- feed. Both outward paths are fixed in code. This file is about the rows that
-- were written before the fix.
--
-- HOW TO USE IT
-- STEP 1 is read only and safe to run right now. It never writes and never
-- casts anything it has not already checked, so it cannot fail on a row it
-- cannot parse. Run it and read the output before anything else happens.
--
-- STEP 2 is commented out. Read the note above it first: pure SQL can only
-- safely handle SOME of these rows, and the rest need
-- backend/scripts/migrate-consultation-notes.js, which defaults to a dry run
-- and reuses the same code path the live booking route now uses.
--
-- NOTHING IN THIS FILE PRINTS AN ANSWER. Only keys, counts and the plain note
-- that would remain. These are health answers and a SQL editor result set gets
-- pasted into places nobody planned for.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 1A. The census. Regex only, so it cannot error on any row.
-- ───────────────────────────────────────────────────────────────────────────
SELECT
  count(*) FILTER (WHERE a.client_notes IS NOT NULL AND btrim(a.client_notes) <> '')
    AS rows_with_any_note,
  count(*) FILTER (WHERE a.client_notes ~ '"consultation"\s*:')
    AS rows_holding_consultation_json,
  count(*) FILTER (WHERE a.client_notes ~ '"consultation"\s*:'
                     AND a.client_notes ~ '^\s*\{[\s\S]*\}\s*$')
    AS parseable,
  count(*) FILTER (WHERE a.client_notes ~ '"consultation"\s*:'
                     AND a.client_notes !~ '^\s*\{[\s\S]*\}\s*$')
    AS not_parseable_left_alone,
  count(*) FILTER (WHERE a.client_notes IS NOT NULL
                     AND btrim(a.client_notes) <> ''
                     AND a.client_notes !~ '"consultation"\s*:')
    AS plain_notes_untouched
FROM appointments a;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 1B. The dry run. One line per appointment holding consultation JSON:
-- what would move, where it would go, and what client_notes would be left
-- holding. Still read only.
--
-- verdict tells you what STEP 2 would do with the row:
--   already_migrated   a completed consultation_responses row exists already,
--                      so nothing happens. This is what makes a re-run safe.
--   sql_can_move       every answer key is a field on ONE form this account
--                      owns, and no signature is involved. STEP 2 handles it.
--   script_only        the keys are the booking page's built in questions, or
--                      they span two forms, or one of them is a signature.
--                      There is no form behind the built in questions, so a
--                      form has to be created before the answers can be filed,
--                      and that is not a job for a hand run SQL statement.
--   cannot_parse       the JSON does not parse. Left exactly as it is.
-- ───────────────────────────────────────────────────────────────────────────
WITH candidate AS (
  SELECT
    a.id,
    a.beautician_id,
    a.client_id,
    a.starts_at,
    a.client_notes,
    -- The cast is guarded by the regex in the same CASE, so a truncated or
    -- malformed blob never reaches ::jsonb.
    CASE WHEN a.client_notes ~ '^\s*\{[\s\S]*\}\s*$'
         THEN a.client_notes::jsonb
    END AS blob
  FROM appointments a
  WHERE a.client_notes ~ '"consultation"\s*:'
),
parsed AS (
  SELECT
    c.*,
    c.blob -> 'consultation' AS consultation,
    nullif(btrim(coalesce(c.blob ->> 'notes', '')), '') AS plain_note_that_would_remain
  FROM candidate c
),
answer_key AS (
  SELECT p.id, k AS answer_key
  FROM parsed p, jsonb_object_keys(
    CASE WHEN jsonb_typeof(p.consultation) = 'object' THEN p.consultation ELSE '{}'::jsonb END
  ) k
),
resolved AS (
  SELECT
    ak.id,
    ak.answer_key,
    f.form_id,
    f.type AS field_type
  FROM answer_key ak
  LEFT JOIN consultation_form_fields f ON f.id::text = ak.answer_key
),
per_appointment AS (
  SELECT
    r.id,
    count(*) AS answer_count,
    count(*) FILTER (WHERE r.form_id IS NOT NULL) AS keys_matching_a_real_field,
    count(*) FILTER (WHERE r.field_type = 'signature') AS signature_keys,
    count(DISTINCT r.form_id) AS distinct_forms,
    min(r.form_id::text) AS only_form_id,
    -- Keys only. Never the answers.
    string_agg(r.answer_key, ', ' ORDER BY r.answer_key) AS answer_keys
  FROM resolved r
  GROUP BY r.id
)
SELECT
  p.id                                AS appointment_id,
  to_char(p.starts_at, 'DD Mon YYYY') AS appointment_date,
  cl.first_name || ' ' || coalesce(cl.last_name, '') AS client,
  coalesce(pa.answer_count, 0)        AS answers_that_would_move,
  pa.answer_keys,
  coalesce(pa.keys_matching_a_real_field, 0) AS keys_matching_a_real_field,
  pa.only_form_id                     AS would_attach_to_form,
  p.plain_note_that_would_remain,
  EXISTS (
    SELECT 1 FROM consultation_responses cr
    WHERE cr.appointment_id = p.id AND cr.status = 'completed'
  )                                   AS already_has_a_response,
  CASE
    WHEN p.blob IS NULL THEN 'cannot_parse'
    WHEN EXISTS (
      SELECT 1 FROM consultation_responses cr
      WHERE cr.appointment_id = p.id AND cr.status = 'completed'
    ) THEN 'already_migrated'
    WHEN pa.answer_count IS NULL OR pa.answer_count = 0 THEN 'nothing_to_move'
    WHEN pa.keys_matching_a_real_field = pa.answer_count
     AND pa.distinct_forms = 1
     AND pa.signature_keys = 0
     AND EXISTS (
       SELECT 1 FROM consultation_forms cf
       WHERE cf.id::text = pa.only_form_id AND cf.beautician_id = p.beautician_id
     ) THEN 'sql_can_move'
    ELSE 'script_only'
  END                                 AS verdict
FROM parsed p
LEFT JOIN per_appointment pa ON pa.id = p.id
LEFT JOIN clients cl ON cl.id = p.client_id
ORDER BY p.starts_at DESC;


-- ═══════════════════════════════════════════════════════════════════════════
-- WHY STEP 2 IS NOT THE WHOLE JOB
--
-- The JSON shape is not one shape. The booking page keys its answers by
-- consultation_form_fields.id when a treatment has a form linked to it, and by
-- five short names ('allergies', 'patch_test', 'medical', 'pregnant',
-- 'previous_reactions') when it does not, because in that case it renders five
-- hard coded questions with no form behind them.
--
-- consultation_responses.form_id is NOT NULL and every reader pairs answers to
-- questions through consultation_form_fields, so a short named answer cannot
-- be filed until a form exists to hold the questions. Creating that form, and
-- re-keying the answers onto its field ids by matching labels, is not
-- something to do by hand in a SQL editor against production.
--
-- So: STEP 2 below covers only the rows STEP 1B calls 'sql_can_move'. For
-- everything else run
--
--     node backend/scripts/migrate-consultation-notes.js            (dry run)
--     node backend/scripts/migrate-consultation-notes.js --apply
--
-- which handles both shapes through the same code the live booking route now
-- uses, and prints exactly what it would do before it does anything.
--
-- Running BOTH is safe. Each skips any appointment that already has a
-- completed consultation_responses row.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 2. DEAD. DO NOT RUN. Use docs/MIGRATE_CONSULTATION_NOTES_STEP2.sql.
--
-- Run against production on 3 August 2026 it moved nothing, and it could never
-- have moved anything. Its `eligible` CTE below refuses any appointment that
-- carries a signature field, spans two forms, or holds an unresolved key. All
-- 14 rows failed at least one: 13 carry a signature (the booking page asks the
-- client to type their name, so every consultation has one), 3 span two forms,
-- 1 is keyed by the five short names. Those were not edge cases to defer to
-- the script. They were the shape of the data.
--
-- Kept here so the reasoning is not lost, and because STEP 1B still calls a
-- row 'sql_can_move' on exactly these terms. Treat that verdict as advisory.
--
-- Idempotent: the INSERT skips any appointment that already has a completed
-- response, and the UPDATE only rewrites client_notes for appointments that
-- have one afterwards. A row it cannot parse is never touched, so no note is
-- destroyed by a shape this statement did not understand.
--
-- Run the two statements together, in one transaction.
-- ───────────────────────────────────────────────────────────────────────────

-- BEGIN;
--
-- WITH candidate AS (
--   SELECT
--     a.id, a.beautician_id, a.client_id,
--     CASE WHEN a.client_notes ~ '^\s*\{[\s\S]*\}\s*$'
--          THEN a.client_notes::jsonb
--     END AS blob
--   FROM appointments a
--   WHERE a.client_notes ~ '"consultation"\s*:'
-- ),
-- parsed AS (
--   SELECT c.id, c.beautician_id, c.client_id,
--          c.blob -> 'consultation' AS consultation
--   FROM candidate c
--   WHERE c.blob IS NOT NULL
--     AND jsonb_typeof(c.blob -> 'consultation') = 'object'
-- ),
-- answer_key AS (
--   SELECT p.id, k AS answer_key
--   FROM parsed p, jsonb_object_keys(p.consultation) k
-- ),
-- resolved AS (
--   SELECT ak.id, ak.answer_key, f.form_id, f.type AS field_type
--   FROM answer_key ak
--   LEFT JOIN consultation_form_fields f ON f.id::text = ak.answer_key
-- ),
-- eligible AS (
--   -- No min(uuid) aggregate exists in Postgres, hence the text round trip.
--   SELECT r.id, min(r.form_id::text)::uuid AS form_id
--   FROM resolved r
--   GROUP BY r.id
--   HAVING count(*) FILTER (WHERE r.form_id IS NULL) = 0
--      AND count(DISTINCT r.form_id) = 1
--      AND count(*) FILTER (WHERE r.field_type = 'signature') = 0
-- )
-- INSERT INTO consultation_responses
--   (form_id, beautician_id, client_id, appointment_id, token, answers,
--    status, completed_at, expires_at)
-- SELECT
--   e.form_id,
--   p.beautician_id,
--   p.client_id,
--   p.id,
--   gen_random_uuid()::text,   -- token is UNIQUE NOT NULL; the row is already
--                              -- completed, so the link it unlocks only ever
--                              -- says "you have already submitted this form"
--   p.consultation,
--   'completed',
--   -- The honest timestamp is when they booked, not when this ran.
--   coalesce(a.created_at, now()),
--   NULL
-- FROM eligible e
-- JOIN parsed p ON p.id = e.id
-- JOIN appointments a ON a.id = p.id
-- JOIN consultation_forms cf ON cf.id = e.form_id AND cf.beautician_id = p.beautician_id
-- WHERE NOT EXISTS (
--   SELECT 1 FROM consultation_responses cr
--   WHERE cr.appointment_id = p.id AND cr.status = 'completed'
-- );
--
-- -- Now, and only now, cut client_notes back to the plain note. Scoped to the
-- -- appointments that actually have a response, so a row the INSERT skipped
-- -- keeps its blob and loses nothing.
-- UPDATE appointments a
-- SET client_notes = nullif(btrim(coalesce(a.client_notes::jsonb ->> 'notes', '')), '')
-- WHERE a.client_notes ~ '"consultation"\s*:'
--   AND a.client_notes ~ '^\s*\{[\s\S]*\}\s*$'
--   AND EXISTS (
--     SELECT 1 FROM consultation_responses cr
--     WHERE cr.appointment_id = a.id AND cr.status = 'completed'
--   );
--
-- COMMIT;


-- ───────────────────────────────────────────────────────────────────────────
-- AFTERWARDS. Re-run STEP 1A. rows_holding_consultation_json should have
-- dropped by exactly the number of rows STEP 1B called 'sql_can_move', and
-- plain_notes_untouched should have gone up by the number of those that had a
-- note worth keeping. Nothing should have moved in not_parseable_left_alone.
-- ───────────────────────────────────────────────────────────────────────────
