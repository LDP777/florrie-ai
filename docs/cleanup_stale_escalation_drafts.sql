-- ONE-TIME cleanup: clear the broken "I need the client's message to draft a
-- reply" placeholder that an OLD version of the front-desk wrote into
-- messages.ai_response. That phrase is NOT in the current code; these are stale
-- rows. The frontend (Hub snippet, Notifications, Outbox) all skip escalations
-- whose ai_response is blank, and the Escalations page just opens an empty
-- editable draft, so nulling these makes the dead drafts disappear cleanly and
-- lets Ellie write a fresh reply on the ones that still need one. The escalation
-- itself is preserved (resolved stays false) so nothing real is lost.
--
-- Paste into the Supabase SQL editor. STEP 1 changes nothing; run it first.

-- STEP 1 - PREVIEW (read-only): how many stale drafts will be cleared
select count(*) as rows_to_clear
from messages
where escalated = true
  and resolved = false
  and ai_response is not null
  and (
       ai_response ilike '%need the client%message%draft%a reply%'
    or ai_response ilike '%i need the client''s message to draft%'
  );

-- (optional) eyeball the actual rows first
-- select id, beautician_id, client_id, created_at, left(ai_response, 120) as draft
-- from messages
-- where escalated = true and resolved = false and ai_response is not null
--   and (ai_response ilike '%need the client%message%draft%a reply%'
--     or ai_response ilike '%i need the client''s message to draft%');

-- STEP 2 - THE CLEANUP (clears the dead drafts). Safe to re-run.
update messages
set ai_response = null
where escalated = true
  and resolved = false
  and ai_response is not null
  and (
       ai_response ilike '%need the client%message%draft%a reply%'
    or ai_response ilike '%i need the client''s message to draft%'
  );
