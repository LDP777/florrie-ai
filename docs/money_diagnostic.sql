-- READ-ONLY. Why is the Money page showing £0? Paste into Supabase SQL editor.
-- Nothing is changed by any of these.

-- 1) Completed appointments in the last 14 days: how many, and how many priced
select
  count(*)                                              as completed_appts,
  count(*) filter (where coalesce(price_cents,0) > 0)   as priced,
  count(*) filter (where coalesce(price_cents,0) = 0)   as unpriced_zero,
  round(coalesce(sum(price_cents),0)/100.0, 2)          as total_price_gbp
from appointments
where status = 'completed'
  and starts_at >= (now() - interval '14 days');

-- 2) Income transactions actually logged in the last 14 days, by type
select type,
       count(*)                              as rows,
       round(coalesce(sum(amount_cents),0)/100.0, 2) as gbp
from transactions
where created_at >= (now() - interval '14 days')
group by type
order by gbp desc;

-- 3) THE GAP: completed + PRICED appointments that have NO income row.
--    A non-empty list here = revenue that should show on the Money page but
--    doesn't (these are what a back-fill would fix).
select a.id, a.starts_at, round(a.price_cents/100.0, 2) as price_gbp
from appointments a
where a.status = 'completed'
  and coalesce(a.price_cents,0) > 0
  and a.starts_at >= (now() - interval '21 days')
  and not exists (
    select 1 from transactions t
    where t.appointment_id = a.id and t.type in ('payment','full_payment')
  )
order by a.starts_at desc;
