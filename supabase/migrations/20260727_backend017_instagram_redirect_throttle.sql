-- 017_instagram_redirect_throttle.sql
--
-- processInstagramDM throttles the "message me on WhatsApp" auto-reply to once
-- per client per 7 days. It read and wrote clients.instagram_redirect_sent_at,
-- but that column lived on `beauticians`, not `clients`. So the read was always
-- undefined and the write silently failed, meaning THE THROTTLE NEVER ENGAGED:
-- every Instagram DM got the redirect reply, including repeats to the same
-- person. Currently masked by Ellie's expired token, but it resumes the moment
-- she reconnects.
alter table clients
  add column if not exists instagram_redirect_sent_at timestamptz;
