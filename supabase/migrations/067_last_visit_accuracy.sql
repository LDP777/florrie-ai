-- 067_last_visit_accuracy.sql
-- clients.last_visit_at was only ever set at import, never updated when an
-- appointment completed. That made dormancy / win-back targeting wrong (a client
-- seen last week still looked lapsed on their stale imported date). Fix:
--   1) a trigger that bumps last_visit_at forward whenever an appointment becomes
--      'completed' (covers manual complete, the daily batch, and auto-complete),
--   2) a one-time backfill from existing completed appointments.

create or replace function bump_client_last_visit() returns trigger as $$
begin
  if new.status = 'completed'
     and (old.status is distinct from 'completed')
     and new.client_id is not null then
    update clients
      set last_visit_at = greatest(coalesce(last_visit_at, new.starts_at), new.starts_at)
      where id = new.client_id;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_bump_last_visit on appointments;
create trigger trg_bump_last_visit
  after update of status on appointments
  for each row execute function bump_client_last_visit();

-- Backfill: correct anyone seen since import.
update clients c
set last_visit_at = sub.last_completed
from (
  select client_id, max(starts_at) as last_completed
  from appointments
  where status = 'completed' and client_id is not null
  group by client_id
) sub
where c.id = sub.client_id
  and (c.last_visit_at is null or sub.last_completed > c.last_visit_at);
