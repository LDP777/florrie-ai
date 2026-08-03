-- ===========================================================================
-- STEP 2, CORRECTED. Run STEP 1 in MIGRATE_CONSULTATION_NOTES.sql first.
--
-- WHY THIS REPLACES THE STEP 2 IN THAT FILE
-- The original STEP 2 moved nothing, and could never have moved anything. Its
-- `eligible` CTE required, per appointment: no signature field, exactly one
-- form, and no unresolved key. Run against production, all 14 rows failed at
-- least one of those:
--
--   13 rows carry a signature field   the booking page asks the client to type
--                                     their name, so every consultation has one
--    3 rows span two forms            brows and lashes booked together ask both
--    1 row is keyed by the five short no form is linked to that treatment, so
--      names                          the page fell back to its built in
--                                     questions, which have no form behind them
--
-- Those were not edge cases to defer to the script. They were the shape of the
-- data. So this does what backend/scripts/migrate-consultation-notes.js does,
-- in SQL, because the sandbox cannot reach Supabase over the network and the
-- SQL editor is the only way in.
--
-- WHAT CHANGES
--   * grouped by (appointment, form) so a booking that asked two forms gets two
--     response rows, which is what the table is for
--   * a signature goes to signature_data, not into answers, because
--     renderResponse skips signature fields and reads that column instead. A
--     signature left in the answers blob is simply never shown
--   * the five built in questions get a backing form created and their answers
--     re-keyed onto its field ids BY LABEL, never by position
--   * client_notes is only cut back where EVERY key was filed
--
-- IDEMPOTENT. Re-running inserts nothing and rewrites nothing.
-- NOTHING HERE PRINTS AN ANSWER.
-- ===========================================================================

BEGIN;

-- 1. The form behind the booking page's five built in questions.
--    consultation_responses.form_id is NOT NULL and every reader pairs an
--    answer to its question through consultation_form_fields, so a short named
--    answer cannot be filed until a form exists to hold the questions.
--    is_default stays false: that flag decides what gets texted to every first
--    time client, and this form holds answers already given.
WITH candidate AS (
  SELECT a.id, a.beautician_id,
         CASE WHEN a.client_notes ~ '^\s*\{[\s\S]*\}\s*$' THEN a.client_notes::jsonb END AS blob
  FROM appointments a
  WHERE a.client_notes ~ '"consultation"\s*:'
),
parsed AS (
  SELECT c.id, c.beautician_id, c.blob -> 'consultation' AS cons
  FROM candidate c
  WHERE c.blob IS NOT NULL AND jsonb_typeof(c.blob -> 'consultation') = 'object'
),
needs_form AS (
  SELECT DISTINCT p.beautician_id
  FROM parsed p
  WHERE EXISTS (
    SELECT 1 FROM jsonb_object_keys(p.cons) k
    WHERE k IN ('allergies','patch_test','medical','pregnant','previous_reactions')
  )
)
INSERT INTO consultation_forms (beautician_id, name, is_default, is_active)
SELECT n.beautician_id, 'Booking page questions', false, true
FROM needs_form n
WHERE NOT EXISTS (
  SELECT 1 FROM consultation_forms cf
  WHERE cf.beautician_id = n.beautician_id AND cf.name = 'Booking page questions'
);

-- 2. Its five questions. Labels must stay identical to
--    DEFAULT_BOOKING_QUESTIONS in backend/src/lib/client-notes.js or the
--    re-keying in step 3 stops matching and the answers stay unreadable.
INSERT INTO consultation_form_fields (form_id, type, label, options, required, sort_order)
SELECT cf.id, q.ftype, q.label, '[]'::jsonb, false, q.sort_order
FROM consultation_forms cf
CROSS JOIN (VALUES
  ('Do you have any known allergies? (e.g. latex, adhesive, tint)',                   'text',   0),
  ('Have you had a patch test in the last 6 months?',                                 'yes_no', 1),
  ('Any medical conditions, medications, or recent treatments we should know about?', 'text',   2),
  ('Are you pregnant or breastfeeding?',                                              'yes_no', 3),
  ('Have you had any adverse reactions to beauty treatments before?',                 'text',   4)
) AS q(label, ftype, sort_order)
WHERE cf.name = 'Booking page questions'
  AND NOT EXISTS (
    SELECT 1 FROM consultation_form_fields f
    WHERE f.form_id = cf.id
      AND lower(regexp_replace(btrim(f.label), '\s+', ' ', 'g'))
        = lower(regexp_replace(btrim(q.label), '\s+', ' ', 'g'))
  );

-- 3. File the answers. One consultation_responses row per (appointment, form).
WITH candidate AS (
  SELECT a.id, a.beautician_id, a.client_id, a.created_at,
         CASE WHEN a.client_notes ~ '^\s*\{[\s\S]*\}\s*$' THEN a.client_notes::jsonb END AS blob
  FROM appointments a
  WHERE a.client_notes ~ '"consultation"\s*:'
),
parsed AS (
  SELECT c.id, c.beautician_id, c.client_id, c.created_at, c.blob -> 'consultation' AS cons
  FROM candidate c
  WHERE c.blob IS NOT NULL AND jsonb_typeof(c.blob -> 'consultation') = 'object'
),
answer AS (
  SELECT p.id AS appointment_id, p.beautician_id, p.client_id, p.created_at, e.key, e.value
  FROM parsed p, jsonb_each(p.cons) e
),
by_field AS (
  -- A key that is already a field id. The form must belong to the same
  -- account: the id came out of a JSON blob, and health data is not the place
  -- to assume an id is hers because it probably is.
  SELECT a.appointment_id, a.beautician_id, a.client_id, a.created_at, a.value,
         f.form_id, a.key AS field_key, f.type AS field_type
  FROM answer a
  JOIN consultation_form_fields f ON f.id::text = a.key
  JOIN consultation_forms cf ON cf.id = f.form_id AND cf.beautician_id = a.beautician_id
),
by_default AS (
  -- One of the five built in questions, re-keyed onto the backing form's field
  -- ids BY LABEL. Never by position: if she edits that form and deletes a
  -- question, positions shift and every answer below it lands under the
  -- question above.
  SELECT a.appointment_id, a.beautician_id, a.client_id, a.created_at, a.value,
         f.form_id, f.id::text AS field_key, f.type AS field_type
  FROM answer a
  JOIN (VALUES
    ('allergies',          'do you have any known allergies? (e.g. latex, adhesive, tint)'),
    ('patch_test',         'have you had a patch test in the last 6 months?'),
    ('medical',            'any medical conditions, medications, or recent treatments we should know about?'),
    ('pregnant',           'are you pregnant or breastfeeding?'),
    ('previous_reactions', 'have you had any adverse reactions to beauty treatments before?')
  ) AS q(key, label) ON q.key = a.key
  JOIN consultation_forms cf ON cf.beautician_id = a.beautician_id AND cf.name = 'Booking page questions'
  JOIN consultation_form_fields f ON f.form_id = cf.id
   AND lower(regexp_replace(btrim(f.label), '\s+', ' ', 'g')) = q.label
),
placed AS (
  SELECT * FROM by_field
  UNION ALL
  SELECT * FROM by_default
),
grouped AS (
  SELECT appointment_id, beautician_id, client_id, created_at, form_id,
         coalesce(jsonb_object_agg(field_key, value) FILTER (WHERE field_type <> 'signature'), '{}'::jsonb) AS answers,
         -- On the booking page the client types their full name to sign, so
         -- that string is the signature. #>> '{}' unwraps the jsonb scalar
         -- rather than leaving the quotes on.
         max(CASE WHEN field_type = 'signature' THEN btrim(value #>> '{}') END) AS signature
  FROM placed
  GROUP BY appointment_id, beautician_id, client_id, created_at, form_id
)
INSERT INTO consultation_responses
  (form_id, beautician_id, client_id, appointment_id, token, answers,
   signature_data, status, completed_at, expires_at)
SELECT g.form_id, g.beautician_id, g.client_id, g.appointment_id,
       -- token is UNIQUE NOT NULL and guards the public form. This row is
       -- already completed, so the link it unlocks only ever says "you have
       -- already submitted this form".
       gen_random_uuid()::text,
       g.answers,
       nullif(g.signature, ''),
       'completed',
       -- The honest timestamp is when they booked, not when this ran.
       coalesce(g.created_at, now()),
       NULL
FROM grouped g
WHERE (g.answers <> '{}'::jsonb OR nullif(g.signature, '') IS NOT NULL)
  AND NOT EXISTS (
    SELECT 1 FROM consultation_responses cr
    WHERE cr.appointment_id = g.appointment_id AND cr.status = 'completed'
  );

-- 4. Now, and only now, cut client_notes back to the plain note. Scoped to
--    appointments where EVERY key was filed, so a row holding a key nothing
--    could explain keeps its blob and loses nothing.
WITH candidate AS (
  SELECT a.id, a.beautician_id,
         CASE WHEN a.client_notes ~ '^\s*\{[\s\S]*\}\s*$' THEN a.client_notes::jsonb END AS blob
  FROM appointments a
  WHERE a.client_notes ~ '"consultation"\s*:'
),
parsed AS (
  SELECT c.id, c.beautician_id, c.blob -> 'consultation' AS cons
  FROM candidate c
  WHERE c.blob IS NOT NULL AND jsonb_typeof(c.blob -> 'consultation') = 'object'
),
answer AS (
  SELECT p.id AS appointment_id, p.beautician_id, k AS key
  FROM parsed p, jsonb_object_keys(p.cons) k
),
placed AS (
  SELECT a.appointment_id, a.key
  FROM answer a
  JOIN consultation_form_fields f ON f.id::text = a.key
  JOIN consultation_forms cf ON cf.id = f.form_id AND cf.beautician_id = a.beautician_id
  UNION
  SELECT a.appointment_id, a.key
  FROM answer a
  JOIN (VALUES
    ('allergies',          'do you have any known allergies? (e.g. latex, adhesive, tint)'),
    ('patch_test',         'have you had a patch test in the last 6 months?'),
    ('medical',            'any medical conditions, medications, or recent treatments we should know about?'),
    ('pregnant',           'are you pregnant or breastfeeding?'),
    ('previous_reactions', 'have you had any adverse reactions to beauty treatments before?')
  ) AS q(key, label) ON q.key = a.key
  JOIN consultation_forms cf ON cf.beautician_id = a.beautician_id AND cf.name = 'Booking page questions'
  JOIN consultation_form_fields f ON f.form_id = cf.id
   AND lower(regexp_replace(btrim(f.label), '\s+', ' ', 'g')) = q.label
),
fully_filed AS (
  SELECT a.appointment_id
  FROM answer a
  LEFT JOIN placed pl ON pl.appointment_id = a.appointment_id AND pl.key = a.key
  GROUP BY a.appointment_id
  HAVING count(*) FILTER (WHERE pl.key IS NULL) = 0
)
UPDATE appointments a
SET client_notes = nullif(btrim(coalesce(a.client_notes::jsonb ->> 'notes', '')), '')
FROM fully_filed ff
WHERE a.id = ff.appointment_id
  AND a.client_notes ~ '"consultation"\s*:'
  AND a.client_notes ~ '^\s*\{[\s\S]*\}\s*$'
  AND EXISTS (
    SELECT 1 FROM consultation_responses cr
    WHERE cr.appointment_id = a.id AND cr.status = 'completed'
  );

COMMIT;
