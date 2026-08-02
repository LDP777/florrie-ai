-- Schema drift catch-up: four columns and two tables that only ever existed in
-- production, never in this directory.
--
-- WHY THIS FILE EXISTS
-- Every one of these was created by hand in the Supabase SQL editor, before
-- there was a migration ledger. Production has them. A database built by
-- replaying this directory does not. The repo was therefore lying about the
-- shape of the schema, and the only way to find out was to run the code and
-- watch it fail.
--
-- Everything here is idempotent on purpose. Against production it is a no-op:
-- the columns and tables are already there, so every statement short-circuits.
-- The point is a NEW database, and any future staging environment, matching
-- what Ellie's account actually looks like.
--
-- HOW TO APPLY
--   1. Run it in Supabase (no-op for the four columns, creates the two tables
--      only if they are somehow absent).
--   2. RESTART Railway. Not redeploy. PgBouncer caches the PostgREST schema
--      and a redeploy does not clear it, so a fresh column stays invisible to
--      the API until the process restarts.
--
-- ORDERING CAVEAT, READ THIS BEFORE BUILDING A DATABASE FROM SCRATCH
-- 20260403_update_plan_tiers.sql already INSERTs into plans.price_annual_cents
-- and it sorts BEFORE this file. On production that never mattered, because
-- the column was added by hand long before the ledger existed. On a genuine
-- from-empty replay, 20260403 will fail on the missing column before this file
-- is ever reached. Fixing it means either hoisting the ADD COLUMN below into
-- an earlier-dated file or amending 20260403 itself, and amending a migration
-- that is already recorded in schema_migrations trips the checksum check by
-- design. Left as a decision, not made silently here.
--
-- No BEGIN/COMMIT in here: backend/scripts/migrate.js already wraps each file
-- in its own transaction and inserts the ledger row inside it. A COMMIT in the
-- file would close that transaction early, before the ledger row was written.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Columns added by hand
-- ─────────────────────────────────────────────────────────────────────────

-- Written by the reschedule path in routes/booking.js so a moved booking still
-- knows where it came from, and so a move made inside the cancellation-notice
-- window can be charged exactly once.
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS rescheduled_from TIMESTAMPTZ;
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS late_reschedule_charged BOOLEAN DEFAULT FALSE;

-- The full link to a consultation form. Nullable because older rows carry only
-- a token and the reading code falls back to building the URL from it.
ALTER TABLE consultation_responses
  ADD COLUMN IF NOT EXISTS form_url TEXT;

-- Annual price in pence. Seeded by 20260403_update_plan_tiers.sql (see the
-- ordering caveat above) and mirrored in backend/src/lib/tiers.js.
ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS price_annual_cents INTEGER;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Follow-up sequences
-- ─────────────────────────────────────────────────────────────────────────
-- Both tables exist in production and have done for a long time. They were
-- created by hand: 052_consolidate_orphan_migrations.sql explicitly refused to
-- create follow_up_enrollments because its foreign key target,
-- follow_up_sequences, "is not created by ANY migration", and said the feature
-- "needs its own migration defining both tables before it can ship". It
-- shipped anyway, straight into the SQL editor. This is that migration,
-- written after the fact.
--
-- The shape below is derived from the code that reads and writes these tables,
-- not from a guess:
--   backend/src/services/automations.js  processFollowUpSequences()
--   frontend/src/pages/AutomationRules.jsx  create / toggle / delete
--   backend/src/routes/clients.js  CLIENT_REF_TABLES (the merge sweep)
-- Anything a column definition here claims can be traced to a line there.

CREATE TABLE IF NOT EXISTS follow_up_sequences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,

  -- AutomationRules.jsx sends name + trigger + steps + active + stats on
  -- create, and nothing else.
  name TEXT NOT NULL,

  -- "after-appointment" is the only value the executor acts on today
  -- (automations.js skips every other trigger), and the only one the create
  -- form offers. Left as free text rather than a CHECK so adding a second
  -- trigger is a code change, not a migration. Quoted because TRIGGER reads as
  -- a keyword and quoting it removes any doubt about how it parses.
  "trigger" TEXT NOT NULL DEFAULT 'after-appointment',

  -- Treatment NAMES, not ids. automations.js does
  -- seq.treatments.includes(appt.treatments.name), so this is text, and an
  -- empty array means "every treatment" because the length check gates it.
  treatments TEXT[] DEFAULT '{}',

  -- [{ delay: '24h', channel: 'whatsapp', message: '...' }]. delay is parsed
  -- by parseDelay() which accepts only /^\d+(h|d)$/.
  steps JSONB NOT NULL DEFAULT '[]',

  -- The executor selects on active = true, the UI toggles it.
  active BOOLEAN NOT NULL DEFAULT TRUE,

  -- { sent, opened, replied }. The UI sums these for its stats strip and seeds
  -- all three at zero on create.
  stats JSONB NOT NULL DEFAULT '{"sent": 0, "opened": 0, "replied": 0}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS follow_up_enrollments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The embedded read in automations.js is
  -- .select('*, clients(...), beauticians(...), follow_up_sequences(steps, name)')
  -- and PostgREST can only resolve those from real foreign keys, so all three
  -- constraints are load-bearing, not decoration.
  sequence_id UUID NOT NULL REFERENCES follow_up_sequences(id) ON DELETE CASCADE,
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,

  -- Nullable on both: the send path already guards with
  -- (enrollment.client_id || null), and an enrolment should survive the
  -- appointment being deleted rather than vanish mid-sequence.
  client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
  appointment_id UUID REFERENCES appointments(id) ON DELETE SET NULL,

  enrolled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Index into follow_up_sequences.steps. Starts at 0, advances by one per
  -- send, and the sequence is finished once it reaches steps.length.
  current_step INTEGER NOT NULL DEFAULT 0,

  -- Nullable: explicitly set to NULL when the last step has been sent, so
  -- "due" and "finished" cannot be confused.
  next_send_at TIMESTAMPTZ,

  -- 'active' or 'completed' are the only values the executor writes.
  status TEXT NOT NULL DEFAULT 'active',

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Phase A of the executor asks "is this appointment already enrolled in this
-- sequence" on every completed appointment in the last hour. Deliberately NOT
-- unique: production rows were created without this constraint and a duplicate
-- would make the migration fail on an existing database, which is exactly the
-- kind of surprise this file is meant to end. The dedup stays where it already
-- is, in the code.
CREATE INDEX IF NOT EXISTS idx_follow_up_enrollments_sequence_appointment
  ON follow_up_enrollments (sequence_id, appointment_id);

-- Phase B: "active enrolments whose next send is due". One index, the exact
-- shape of the query.
CREATE INDEX IF NOT EXISTS idx_follow_up_enrollments_due
  ON follow_up_enrollments (status, next_send_at);

-- clients.js CLIENT_REF_TABLES rewrites client_id on every referencing table
-- when two duplicate clients are merged. Without this that sweep is a scan.
CREATE INDEX IF NOT EXISTS idx_follow_up_enrollments_client
  ON follow_up_enrollments (client_id);

-- The executor loads sequences with .eq('active', true) and the UI loads one
-- beautician's at a time.
CREATE INDEX IF NOT EXISTS idx_follow_up_sequences_beautician
  ON follow_up_sequences (beautician_id, created_at);

-- RLS: the backend holds the service key and bypasses this. The policies exist
-- because AutomationRules.jsx reads and writes follow_up_sequences with the
-- anon key, directly from the browser. The subquery form is the canonical one
-- for this schema; comparing beautician_id to auth.uid() directly is the H12
-- bug (beautician_id is the beauticians PK, auth.uid() is the auth user id)
-- and returns zero rows for every frontend read.
ALTER TABLE follow_up_sequences ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS follow_up_sequences_own ON follow_up_sequences;
CREATE POLICY follow_up_sequences_own ON follow_up_sequences
  FOR ALL USING (beautician_id IN (SELECT id FROM beauticians WHERE auth_id = auth.uid()));

ALTER TABLE follow_up_enrollments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS follow_up_enrollments_own ON follow_up_enrollments;
CREATE POLICY follow_up_enrollments_own ON follow_up_enrollments
  FOR ALL USING (beautician_id IN (SELECT id FROM beauticians WHERE auth_id = auth.uid()));

COMMENT ON TABLE follow_up_sequences IS
  'Aftercare / rebook message sequences. Created by hand in production before the migration ledger existed. This file exists so a fresh database matches.';
COMMENT ON TABLE follow_up_enrollments IS
  'One row per client per sequence they are working through. Created by hand in production before the migration ledger existed. This file exists so a fresh database matches.';
