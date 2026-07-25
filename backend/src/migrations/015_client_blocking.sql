-- 015_client_blocking.sql
--
-- Let Ellie block a problem client. A blocked client cannot book online
-- (booking.js rejects them on the phone/email match). Nullable timestamp so we
-- also record WHEN they were blocked; NULL = not blocked.
alter table clients
  add column if not exists blocked_at timestamptz;

create index if not exists idx_clients_blocked
  on clients (beautician_id) where blocked_at is not null;
