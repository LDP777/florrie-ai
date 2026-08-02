-- Two columns the code has always needed and production has never had.
--
-- HOW THESE WERE FOUND
-- By querying the live database for the columns the code names, not by reading
-- this directory. That distinction matters: the migrations here describe a
-- schema that production only partly matches, so a column can look present in
-- 001 or 007 and still be absent from Ellie's database, or the reverse.
-- Eleven code-named columns were checked against production. Nine of them were
-- code bugs and are fixed in code (wrong name for a column that does exist, or
-- a table shape the code had wrong). These two are the only ones where the
-- intent is real and production genuinely has nowhere to put the value.
--
-- WHY THIS CLASS OF BUG IS INVISIBLE
-- PostgREST rejects an ENTIRE select when one column name is unknown, and this
-- codebase very often writes `const { data } = await ...` without reading the
-- error. So `data` comes back null, the feature shows nothing, and it reads as
-- "quiet week" rather than "broken". Every call site touched alongside this
-- migration now reads the error. That is the actual fix; the columns are just
-- the symptom.
--
-- HOW TO APPLY
--   1. Run it in Supabase.
--   2. RESTART Railway. Not redeploy. PgBouncer caches the PostgREST schema and
--      a redeploy does not clear it, so a fresh column stays invisible to the
--      API until the process restarts.
--
-- Idempotent throughout: ADD COLUMN IF NOT EXISTS, so a second run is a no-op.
--
-- No BEGIN/COMMIT: backend/scripts/migrate.js already wraps each file in its
-- own transaction and writes the ledger row inside it. A COMMIT here would
-- close that transaction before the ledger row was written.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. ai_actions.status
-- ─────────────────────────────────────────────────────────────────────────
-- Needed by:
--   backend/src/routes/agent-status.js:96
--     .select('id, action_type, status, created_at, details')
--     This is GET /api/agents/status, the agent dashboard. The unknown column
--     made PostgREST reject the whole select, the route hit its error branch,
--     and it has been returning a flat 500 "Failed to fetch agent data" for as
--     long as the column has been named. This is the live, user-visible break.
--   backend/src/services/review-requests.js:66
--     .eq('status', 'scheduled')  and the four .update({ status: ... }) calls
--     at :95, :138, :181, :191. The queue query returned null every run, so
--     processReviewRequests() reported "0 sent" forever.
--   backend/src/routes/ai-actions.js:115, :146, :168
--     the approve and dismiss handlers read and write it.
--
-- TEXT, and deliberately NO DEFAULT. Every existing row is finished history.
-- Giving them a queue value such as 'scheduled' or 'pending_approval' would
-- resurrect every AI action ever logged into an approvals list. NULL keeps them
-- out of both queue filters (.eq('status', ...) never matches NULL) while
-- leaving them fully visible in the activity feed, which does not filter on
-- status at all.
--
-- No CHECK constraint on purpose. The known values are 'scheduled', 'executed',
-- 'dismissed' and 'pending_approval', but a value nobody enumerated would be
-- rejected whole, which is the exact failure mode this file exists to end.
ALTER TABLE ai_actions
  ADD COLUMN IF NOT EXISTS status TEXT;

COMMENT ON COLUMN ai_actions.status IS
  'Lifecycle of the action: scheduled, pending_approval, executed, dismissed. Separate axis from outcome, which records the RESULT (success, pending, failed, escalated). NULL means historical, already finished.';

-- The shape of the review-request queue query: action_type then status.
CREATE INDEX IF NOT EXISTS idx_ai_actions_type_status
  ON ai_actions (action_type, status);

-- ─────────────────────────────────────────────────────────────────────────
-- 2. client_intelligence.next_predicted_visit
-- ─────────────────────────────────────────────────────────────────────────
-- Needed by:
--   backend/src/services/predictive-nudge.js:73, :75, :76
--     selects it, then filters it to a 3-to-7-day window. The unknown column
--     killed the whole select, `intelligence` came back null, and
--     runPredictiveNudges() returned 0 on every scheduled run. Registered as
--     the 'predictive-nudges' job in backend/src/jobs/register.js:130, so it
--     has been running daily and finding nobody since the day it shipped.
--
-- There is no existing equivalent to rename to. rebooking_rhythm_days is the
-- average GAP in days, not a date, and clients.next_expected_visit belongs to a
-- different table on a different write path.
--
-- DATE, not TIMESTAMPTZ, because the only producer writes a YYYY-MM-DD string:
-- backend/src/services/client-intelligence.js:139 in the upsert. That upsert
-- previously computed the value and threw it away, which is why this column
-- also needed a one-line code fix; without it the column would be added and
-- stay NULL forever, and the nudge would find nobody exactly as before.
-- predictive-nudge.js compares it against full ISO timestamps and Postgres
-- casts those to date for the comparison, which is correct to the day.
ALTER TABLE client_intelligence
  ADD COLUMN IF NOT EXISTS next_predicted_visit DATE;

COMMENT ON COLUMN client_intelligence.next_predicted_visit IS
  'Predicted date of the next visit: last visit plus the average booking gap. Written by services/client-intelligence.js, read by services/predictive-nudge.js. NULL when the client has too few visits to predict from.';

-- The shape of the predictive-nudge query: one beautician, a date window.
CREATE INDEX IF NOT EXISTS idx_client_intelligence_next_visit
  ON client_intelligence (beautician_id, next_predicted_visit);

-- ─────────────────────────────────────────────────────────────────────────
-- 3. Checked and deliberately NOT added
-- ─────────────────────────────────────────────────────────────────────────
-- These were confirmed absent from production too. Each one is a code bug, not
-- a missing column, and adding it would have propped up code that was wrong.
--
--   expenses.amount_pence          the column is amount_cents. Renamed in
--                                  routes/coach.js.
--   daily_checklists.type          the column is list_type. Renamed in
--                                  pages/DailyChecklist.jsx.
--   daily_checklists.items         daily_checklists is one row PER ITEM
--                                  (label, list_type, done, sort_order). There
--                                  was never an items array. Three writers were
--                                  rewritten to the real shape.
--   clients.is_active              never existed. The codebase's real "still on
--                                  the books" test is archived_at IS NULL.
--   automation_rules.enabled       the column is is_active.
--   reviews.is_active              not read or written anywhere in backend/src
--                                  or frontend/src. Nothing to support.
--   transactions.booked_via        same: no reader, no writer. booked_via is an
--                                  appointments column and is present there.
--   revenue_goals.target_month     never existed; the real table is period,
--                                  target_cents, start_date, end_date, all NOT
--                                  NULL. The four routes that used it had no
--                                  caller and could never have inserted a row.
--                                  Deleted rather than propped up.
--   end_of_day_reports.report_date the column is date. The GET route was
--                                  renamed; the POST route wrote three more
--                                  columns that exist in no migration and had
--                                  no caller, so it was removed rather than
--                                  guessed at.
