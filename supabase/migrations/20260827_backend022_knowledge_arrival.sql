-- 022: 'arrival' joins the knowledge base categories.
--
-- 27 August 2026, 11:32. A client wrote "Im 60 seconds away!" and Florrie
-- answered on her own with "Oh I'm ready! I'll come get you xx". A minute later
-- Ellie wrote over the top of her own assistant, to a client already on the
-- step: "Come through when you're here! It's a bit hectic with the festival
-- staff".
--
-- Ellie's sentence is why this category exists. A correct answer to a doorstep
-- message EXISTS and it is nine words long. Florrie's failure was not speaking,
-- it was speaking from nothing: she cannot see the room, so "I'm ready" was
-- invented, and she has no body in the building, so "I'll come get you" was a
-- promise Ellie had to contradict.
--
-- So the owner writes the arrival instruction ONCE ("Come through when you get
-- here, no need to knock. Parking is on Mill Street.") and every client at the
-- door gets it back in her own words, in one second. lib/knowledge.js forces
-- the note into the prompt for a doorstep message (lexical retrieval would
-- otherwise drop it: "Im 60 seconds away!" shares no keyword with it), and
-- lib/reply-claims-guard.js refuses, facet by facet, anything the note does not
-- actually cover.
--
-- WITHOUT THIS MIGRATION the whole feature is dead in production and fails
-- loudly: the CHECK constraint written in migration 019 does not know the word,
-- so saving an arrival entry comes back 23514 and the owner cannot write the
-- one note the code is asking her for.
--
-- Migration 019 is NOT edited. It has already been run by hand against live
-- databases, so a change there is a change nobody applies.
--
-- Run by hand in the Supabase SQL editor (idempotent, safe to re-run).
-- After running, RESTART Railway so PgBouncer's schema cache sees the change.

DO $$
DECLARE
  existing RECORD;
BEGIN
  -- Nothing to widen before 019 has been run. Skipping quietly is right here:
  -- 019 creates the table with the full list from the start on a fresh
  -- database, and running these out of order should not be an error.
  IF to_regclass('public.knowledge_entries') IS NULL THEN
    RAISE NOTICE 'knowledge_entries does not exist yet, run migration 019 first';
    RETURN;
  END IF;

  -- Dropped by whatever name Postgres actually gave it, not by the name we
  -- expect. 019 wrote the CHECK inline with no name, so it is
  -- 'knowledge_entries_category_check' on every database we have seen, but an
  -- inline constraint name is generated rather than promised, and a migration
  -- that is pasted into a SQL editor by hand should not bet on it. Re-running
  -- this file drops the constraint added below and puts back an identical one.
  FOR existing IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.knowledge_entries'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%category%'
  LOOP
    EXECUTE format('ALTER TABLE knowledge_entries DROP CONSTRAINT %I', existing.conname);
  END LOOP;

  ALTER TABLE knowledge_entries
    ADD CONSTRAINT knowledge_entries_category_check
    CHECK (category IN ('arrival','aftercare','policy','treatment','prep','faq','general'));
END $$;

COMMENT ON COLUMN knowledge_entries.category IS
  'arrival is what to do on getting here: knock, come through, where to park. Added 27 Aug 2026 so a client at the door gets the owner''s own words instead of an invented reply. Keep this list in step with KNOWLEDGE_CATEGORIES in backend/src/lib/knowledge.js.';
