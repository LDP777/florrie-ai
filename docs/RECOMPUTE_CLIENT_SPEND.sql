-- RECOMPUTE_CLIENT_SPEND.sql
--
-- Ellie: "Says 0 spent but this client been to me 3 times this month."
--
-- clients.total_spend_cents and total_visits were only ever incremented by two
-- endpoints (POST /:id/complete, which nothing calls, and /complete-day). The
-- paths that complete most appointments, the auto-complete cron and the
-- one-tap PATCH complete, never incremented them. Code now fixed to increment
-- on every completion path; this repairs the history.
--
-- Recomputed wholesale from completed appointments, which survive the known
-- transactions gaps (the silent 'card' insert failures and the dead webhook).
--
-- STEP 1 (DRY RUN): see what would change. Expect regulars currently at 0.
select
  c.first_name || ' ' || coalesce(c.last_name, '') as client,
  c.total_visits  as visits_now,
  x.real_visits,
  c.total_spend_cents / 100.0 as spend_now_pounds,
  x.real_spend_cents / 100.0  as real_spend_pounds
from clients c
join (
  select client_id,
         count(*)                              as real_visits,
         coalesce(sum(price_cents), 0)         as real_spend_cents
  from appointments
  where status = 'completed' and client_id is not null
  group by client_id
) x on x.client_id = c.id
where c.total_visits is distinct from x.real_visits
   or c.total_spend_cents is distinct from x.real_spend_cents
order by x.real_spend_cents desc
limit 100;

-- STEP 2 (THE WRITE): run after reading step 1.
-- update clients c
-- set total_visits      = x.real_visits,
--     total_spend_cents = x.real_spend_cents
-- from (
--   select client_id,
--          count(*)                      as real_visits,
--          coalesce(sum(price_cents), 0) as real_spend_cents
--   from appointments
--   where status = 'completed' and client_id is not null
--   group by client_id
-- ) x
-- where x.client_id = c.id
--   and (c.total_visits is distinct from x.real_visits
--        or c.total_spend_cents is distinct from x.real_spend_cents);
