-- 024: one client row per Instagram sender, per salon.
--
-- 31 August 2026, the night Instagram went live for @ellindigo.
--
-- routes/instagram-webhooks.js looks a sender up with
--   .eq('beautician_id', ...).eq('instagram_id', ...)
-- and, until today, .single(). Migration 021 created the matching index
-- WITHOUT a unique constraint:
--
--   CREATE INDEX IF NOT EXISTS idx_clients_instagram_id
--     ON clients (beautician_id, instagram_id) WHERE instagram_id IS NOT NULL;
--
-- so two DMs arriving within the same second both missed the lookup and both
-- inserted. That is not a one-off cosmetic duplicate. From the moment a second
-- row exists, `.single()` resolves with { data: null, error } on EVERY message
-- from that person, which the code read as "no such client", so it inserted
-- another row, and another, one per DM, forever. Her thread splits across all
-- of them and her history stops being her history.
--
-- 053_clients_whatsapp_id_unique.sql is exactly this fix for exactly this
-- defect on WhatsApp, three months earlier. The webhook now also uses
-- .maybeSingle(), so existing duplicates degrade to "picked one" instead of
-- "created another", but the index is what actually stops it.
--
-- Run by hand in the Supabase SQL editor. Idempotent, safe to re-run.
-- After running, RESTART Railway so PgBouncer's schema cache sees the change.

-- STEP 1: say plainly whether this database can take the index.
--
-- CREATE UNIQUE INDEX on a table that already holds duplicates fails with
-- "could not create unique index ... Key (beautician_id, instagram_id)=(...)
-- is duplicated", one pair at a time, which tells you almost nothing about the
-- size of the problem. This block counts them all first and names them, so
-- whoever runs it knows what they are looking at before they start merging.
DO $$
DECLARE
  pairs   integer;
  rows_   integer;
  sample  text;
BEGIN
  SELECT count(*), coalesce(sum(n), 0), string_agg(format('%s/%s x%s', beautician_id, instagram_id, n), ', ')
    INTO pairs, rows_, sample
    FROM (
      SELECT beautician_id, instagram_id, count(*) AS n
        FROM clients
       WHERE instagram_id IS NOT NULL
       GROUP BY beautician_id, instagram_id
      HAVING count(*) > 1
       LIMIT 20
    ) d;

  IF coalesce(pairs, 0) > 0 THEN
    RAISE EXCEPTION
      'clients already holds % duplicated (beautician_id, instagram_id) pair(s), % row(s) in total, so the unique index cannot be created yet. Merge them first, then re-run this file. Offenders (up to 20): %',
      pairs, rows_, sample
      USING HINT =
        'List them with: SELECT beautician_id, instagram_id, count(*), array_agg(id ORDER BY created_at) FROM clients WHERE instagram_id IS NOT NULL GROUP BY 1,2 HAVING count(*) > 1; then repoint messages/appointments at the OLDEST id in each array and delete the newer rows. Do not just delete: the newer rows are where the recent messages are.';
  END IF;
END $$;

-- STEP 2: the constraint itself. Partial, so the many clients with no
-- Instagram at all are unaffected and can stay NULL as often as they like.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_clients_beautician_instagram_id
  ON clients (beautician_id, instagram_id)
  WHERE instagram_id IS NOT NULL;

COMMENT ON INDEX uniq_clients_beautician_instagram_id IS
  'One client row per Instagram sender per salon. Added 31 Aug 2026 after migration 021 shipped the same index without UNIQUE, which let two simultaneous DMs create two rows and then a new row on every message thereafter. Mirrors uniq_clients_beautician_whatsapp_id (migration 053).';
