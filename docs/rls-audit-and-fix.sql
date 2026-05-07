-- ============================================================================
-- RLS audit + auto-fix for Florrie prod (project: driyreevwogxngqyshtc)
--
-- Triggered by: Supabase weekly advisor email "Action required: security
-- vulnerabilities detected" (received Wed 6 May 2026, 09:36 BST)
-- Issue: rls_disabled_in_public on at least one public.* table
--
-- HOW TO RUN
--   Supabase Dashboard -> SQL Editor -> New query -> paste this whole file ->
--   Run. Read the audit output BEFORE the fix block runs (it runs at the end).
--
-- WHAT IT DOES
--   1. Shows every public table + its RLS status + policy count (READ ONLY)
--   2. Shows tables with RLS ON but NO policies (deny-all silent break risk)
--   3. Enables RLS on any public table where it is currently OFF
--      (Backend uses service_role which bypasses RLS, so this is safe for the
--      API path. Direct frontend reads via anon/authenticated will hit a
--      deny-all wall until policies exist - intentional, that is the security
--      we want.)
--
-- WHAT IT DOES NOT DO
--   - Does NOT auto-create policies. If a table needs anon/authenticated
--     access, you add the right policy after RLS is enabled. We do not guess.
--   - Does NOT touch tables in non-public schemas (auth, storage, realtime,
--     extensions, supabase_*, vault, etc.) - Supabase manages those.
-- ============================================================================


-- ============================================================================
-- 1. AUDIT: Every public table with RLS status + policy count
-- ============================================================================
SELECT
    c.relname                                              AS table_name,
    CASE WHEN c.relrowsecurity THEN 'ENABLED' ELSE 'DISABLED' END AS rls_status,
    COALESCE((
        SELECT count(*) FROM pg_policies p
        WHERE p.schemaname = 'public' AND p.tablename = c.relname
    ), 0)                                                  AS policy_count
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'                                      -- ordinary tables only
ORDER BY c.relrowsecurity ASC, c.relname ASC;              -- DISABLED first


-- ============================================================================
-- 2. RISK QUERY: Tables with RLS ENABLED but ZERO policies (silent deny-all)
-- ============================================================================
SELECT
    c.relname AS table_name,
    'RLS on, no policies. Anon + authenticated cannot read or write. '
    'Service role still works. Check if frontend needs direct access.'
    AS warning
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND c.relrowsecurity = true
  AND NOT EXISTS (
      SELECT 1 FROM pg_policies p
      WHERE p.schemaname = 'public' AND p.tablename = c.relname
  )
ORDER BY c.relname;


-- ============================================================================
-- 3. FIX: Enable RLS on any public table where it is currently OFF
--    Idempotent. Safe to run multiple times.
-- ============================================================================
DO $$
DECLARE
    r record;
    fixed_count int := 0;
BEGIN
    FOR r IN
        SELECT c.relname AS table_name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND c.relrowsecurity = false
    LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.table_name);
        RAISE NOTICE 'Enabled RLS on public.%', r.table_name;
        fixed_count := fixed_count + 1;
    END LOOP;

    IF fixed_count = 0 THEN
        RAISE NOTICE 'No tables needed fixing. All public tables already have RLS enabled.';
    ELSE
        RAISE NOTICE 'Fixed % table(s). Re-run the audit query above to confirm.', fixed_count;
    END IF;
END $$;


-- ============================================================================
-- 4. POST-FIX VERIFICATION: Re-run the audit. All rows should show ENABLED.
-- ============================================================================
SELECT
    c.relname                                              AS table_name,
    CASE WHEN c.relrowsecurity THEN 'ENABLED' ELSE 'DISABLED' END AS rls_status,
    COALESCE((
        SELECT count(*) FROM pg_policies p
        WHERE p.schemaname = 'public' AND p.tablename = c.relname
    ), 0)                                                  AS policy_count
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
ORDER BY c.relrowsecurity ASC, c.relname ASC;


-- ============================================================================
-- AFTER RUNNING
--
-- - If the post-fix audit still shows any DISABLED rows: report back, that
--   means a non-public schema table is the one Supabase flagged.
-- - If the risk query (block 2) returns rows: those tables are now RLS-on
--   but have no policies. Service role still works. If the frontend was
--   reading them directly via Supabase client (not via your backend API),
--   that path will now 403 - you need to add explicit policies. Most
--   Florrie tables already have policies from the migrations, so this
--   should be a short list, if any.
-- - Then click "Resolve issue" in Supabase dashboard or wait for the
--   next weekly advisor digest to confirm the warning has cleared.
-- ============================================================================
