-- Florrie.ai — Row Level Security Policies
-- Migration 005: Enable RLS on all tables with appropriate access controls
-- Created: 2026-03-27

-- ============================================================
-- HELPER: Get the beautician_id for the currently authenticated user
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_my_beautician_id()
RETURNS UUID AS $$
  SELECT id FROM public.beauticians WHERE auth_id = auth.uid() LIMIT 1;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- ============================================================
-- 1. BEAUTICIANS — users can only access their own record
-- ============================================================
ALTER TABLE beauticians ENABLE ROW LEVEL SECURITY;

CREATE POLICY "beauticians_select_own" ON beauticians
  FOR SELECT USING (auth_id = auth.uid());

CREATE POLICY "beauticians_update_own" ON beauticians
  FOR UPDATE USING (auth_id = auth.uid());

CREATE POLICY "beauticians_insert_own" ON beauticians
  FOR INSERT WITH CHECK (auth_id = auth.uid());

-- Public booking pages need to read beautician profiles by slug
CREATE POLICY "beauticians_select_public_booking" ON beauticians
  FOR SELECT USING (booking_slug IS NOT NULL);

-- ============================================================
-- 2. TREATMENTS — beautician can CRUD their own; public can read for booking
-- ============================================================
ALTER TABLE treatments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "treatments_select_own" ON treatments
  FOR SELECT USING (beautician_id = public.get_my_beautician_id());

CREATE POLICY "treatments_insert_own" ON treatments
  FOR INSERT WITH CHECK (beautician_id = public.get_my_beautician_id());

CREATE POLICY "treatments_update_own" ON treatments
  FOR UPDATE USING (beautician_id = public.get_my_beautician_id());

CREATE POLICY "treatments_delete_own" ON treatments
  FOR DELETE USING (beautician_id = public.get_my_beautician_id());

-- Public booking: anyone can view treatments for a given beautician
CREATE POLICY "treatments_select_public" ON treatments
  FOR SELECT USING (true);

-- ============================================================
-- 3. CLIENTS — beautician can CRUD their own clients
-- ============================================================
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;

CREATE POLICY "clients_select_own" ON clients
  FOR SELECT USING (beautician_id = public.get_my_beautician_id());

CREATE POLICY "clients_insert_own" ON clients
  FOR INSERT WITH CHECK (beautician_id = public.get_my_beautician_id());

CREATE POLICY "clients_update_own" ON clients
  FOR UPDATE USING (beautician_id = public.get_my_beautician_id());

CREATE POLICY "clients_delete_own" ON clients
  FOR DELETE USING (beautician_id = public.get_my_beautician_id());

-- ============================================================
-- 4. APPOINTMENTS — beautician's own; anon can insert for public booking
-- ============================================================
ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "appointments_select_own" ON appointments
  FOR SELECT USING (beautician_id = public.get_my_beautician_id());

CREATE POLICY "appointments_insert_own" ON appointments
  FOR INSERT WITH CHECK (beautician_id = public.get_my_beautician_id());

CREATE POLICY "appointments_update_own" ON appointments
  FOR UPDATE USING (beautician_id = public.get_my_beautician_id());

CREATE POLICY "appointments_delete_own" ON appointments
  FOR DELETE USING (beautician_id = public.get_my_beautician_id());

-- Public booking: anonymous users can insert appointments
CREATE POLICY "appointments_insert_public_booking" ON appointments
  FOR INSERT WITH CHECK (true);

-- ============================================================
-- 5. WAITLIST — beautician's own; public can insert
-- ============================================================
ALTER TABLE waitlist ENABLE ROW LEVEL SECURITY;

CREATE POLICY "waitlist_select_own" ON waitlist
  FOR SELECT USING (beautician_id = public.get_my_beautician_id());

CREATE POLICY "waitlist_insert_own" ON waitlist
  FOR INSERT WITH CHECK (beautician_id = public.get_my_beautician_id());

CREATE POLICY "waitlist_update_own" ON waitlist
  FOR UPDATE USING (beautician_id = public.get_my_beautician_id());

CREATE POLICY "waitlist_delete_own" ON waitlist
  FOR DELETE USING (beautician_id = public.get_my_beautician_id());

-- Public: anyone can join waitlist
CREATE POLICY "waitlist_insert_public" ON waitlist
  FOR INSERT WITH CHECK (true);

-- ============================================================
-- 6. MESSAGES — beautician's own only
-- ============================================================
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "messages_select_own" ON messages
  FOR SELECT USING (beautician_id = public.get_my_beautician_id());

CREATE POLICY "messages_insert_own" ON messages
  FOR INSERT WITH CHECK (beautician_id = public.get_my_beautician_id());

CREATE POLICY "messages_update_own" ON messages
  FOR UPDATE USING (beautician_id = public.get_my_beautician_id());

-- ============================================================
-- 7. TRANSACTIONS — beautician's own only
-- ============================================================
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "transactions_select_own" ON transactions
  FOR SELECT USING (beautician_id = public.get_my_beautician_id());

CREATE POLICY "transactions_insert_own" ON transactions
  FOR INSERT WITH CHECK (beautician_id = public.get_my_beautician_id());

CREATE POLICY "transactions_update_own" ON transactions
  FOR UPDATE USING (beautician_id = public.get_my_beautician_id());

-- ============================================================
-- 8. EXPENSES — beautician's own only
-- ============================================================
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "expenses_select_own" ON expenses
  FOR SELECT USING (beautician_id = public.get_my_beautician_id());

CREATE POLICY "expenses_insert_own" ON expenses
  FOR INSERT WITH CHECK (beautician_id = public.get_my_beautician_id());

CREATE POLICY "expenses_update_own" ON expenses
  FOR UPDATE USING (beautician_id = public.get_my_beautician_id());

CREATE POLICY "expenses_delete_own" ON expenses
  FOR DELETE USING (beautician_id = public.get_my_beautician_id());

-- ============================================================
-- 9. AI_ACTIONS — beautician's own only
-- ============================================================
ALTER TABLE ai_actions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ai_actions_select_own" ON ai_actions
  FOR SELECT USING (beautician_id = public.get_my_beautician_id());

CREATE POLICY "ai_actions_insert_own" ON ai_actions
  FOR INSERT WITH CHECK (beautician_id = public.get_my_beautician_id());

CREATE POLICY "ai_actions_update_own" ON ai_actions
  FOR UPDATE USING (beautician_id = public.get_my_beautician_id());

-- ============================================================
-- 10. CAMPAIGNS — beautician's own only
-- ============================================================
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;

CREATE POLICY "campaigns_select_own" ON campaigns
  FOR SELECT USING (beautician_id = public.get_my_beautician_id());

CREATE POLICY "campaigns_insert_own" ON campaigns
  FOR INSERT WITH CHECK (beautician_id = public.get_my_beautician_id());

CREATE POLICY "campaigns_update_own" ON campaigns
  FOR UPDATE USING (beautician_id = public.get_my_beautician_id());

CREATE POLICY "campaigns_delete_own" ON campaigns
  FOR DELETE USING (beautician_id = public.get_my_beautician_id());

-- ============================================================
-- 11. CONTENT_POSTS — beautician's own only
-- ============================================================
ALTER TABLE content_posts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "content_posts_select_own" ON content_posts
  FOR SELECT USING (beautician_id = public.get_my_beautician_id());

CREATE POLICY "content_posts_insert_own" ON content_posts
  FOR INSERT WITH CHECK (beautician_id = public.get_my_beautician_id());

CREATE POLICY "content_posts_update_own" ON content_posts
  FOR UPDATE USING (beautician_id = public.get_my_beautician_id());

CREATE POLICY "content_posts_delete_own" ON content_posts
  FOR DELETE USING (beautician_id = public.get_my_beautician_id());

-- ============================================================
-- 12. CLIENT_INTELLIGENCE — beautician's own only
-- ============================================================
ALTER TABLE client_intelligence ENABLE ROW LEVEL SECURITY;

CREATE POLICY "client_intelligence_select_own" ON client_intelligence
  FOR SELECT USING (beautician_id = public.get_my_beautician_id());

CREATE POLICY "client_intelligence_insert_own" ON client_intelligence
  FOR INSERT WITH CHECK (beautician_id = public.get_my_beautician_id());

CREATE POLICY "client_intelligence_update_own" ON client_intelligence
  FOR UPDATE USING (beautician_id = public.get_my_beautician_id());

-- ============================================================
-- 13. VOICE_NOTES — beautician's own only
-- ============================================================
ALTER TABLE voice_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "voice_notes_select_own" ON voice_notes
  FOR SELECT USING (beautician_id = public.get_my_beautician_id());

CREATE POLICY "voice_notes_insert_own" ON voice_notes
  FOR INSERT WITH CHECK (beautician_id = public.get_my_beautician_id());

CREATE POLICY "voice_notes_update_own" ON voice_notes
  FOR UPDATE USING (beautician_id = public.get_my_beautician_id());

-- ============================================================
-- 14. PLANS — read-only for all authenticated users (public pricing)
-- ============================================================
ALTER TABLE plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "plans_select_all" ON plans
  FOR SELECT USING (true);

-- Only service role can insert/update/delete plans (no policy needed, service role bypasses RLS)

-- ============================================================
-- 15. STRIPE_EVENTS — service role only (webhook processing)
-- No anon/authenticated policies — only service role can access
-- ============================================================
ALTER TABLE stripe_events ENABLE ROW LEVEL SECURITY;

-- No policies = no access for anon/authenticated. Service role bypasses RLS.

-- ============================================================
-- 16. TEAM_MEMBERS — beautician's own team
-- ============================================================
ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "team_members_select_own" ON team_members
  FOR SELECT USING (beautician_id = public.get_my_beautician_id());

CREATE POLICY "team_members_insert_own" ON team_members
  FOR INSERT WITH CHECK (beautician_id = public.get_my_beautician_id());

CREATE POLICY "team_members_update_own" ON team_members
  FOR UPDATE USING (beautician_id = public.get_my_beautician_id());

CREATE POLICY "team_members_delete_own" ON team_members
  FOR DELETE USING (beautician_id = public.get_my_beautician_id());

-- ============================================================
-- GRANT: anon role needs SELECT on beauticians + treatments for public booking
-- (Supabase grants these by default on public schema, but being explicit)
-- ============================================================
GRANT SELECT ON beauticians TO anon;
GRANT SELECT ON treatments TO anon;
GRANT INSERT ON appointments TO anon;
GRANT INSERT ON waitlist TO anon;
GRANT SELECT ON plans TO anon;
