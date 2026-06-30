-- ONE-TIME back-fill: write the missing takings for completed, priced
-- appointments that never got an income row (the reason the Money page read low).
-- Mirrors auto-complete exactly: takings = price minus any deposit already
-- counted, type='payment', payment_method=null (so a no-show reversal still
-- clears it). Idempotent (NOT EXISTS guard) and dates each income row to when
-- the appointment actually happened so it lands in the right week/month.
--
-- Paste into the Supabase SQL editor. STEP 1 changes nothing; run it first.

-- STEP 1 - PREVIEW (read-only): how many rows and how much will be recovered
select
  count(*) as rows_to_insert,
  round(sum(greatest(0, coalesce(a.price_cents,0)
       - case when a.deposit_paid then coalesce(a.deposit_cents,0) else 0 end))/100.0, 2) as total_gbp
from appointments a
where a.status='completed'
  and coalesce(a.price_cents,0) > 0
  and greatest(0, coalesce(a.price_cents,0)
       - case when a.deposit_paid then coalesce(a.deposit_cents,0) else 0 end) > 0
  and not exists (select 1 from transactions t
                  where t.appointment_id=a.id and t.type in ('payment','full_payment'));

-- STEP 2 - THE BACK-FILL (writes the rows). Safe to re-run; the guard skips
-- anything already logged.
insert into transactions
  (beautician_id, appointment_id, client_id, treatment_id, amount_cents,
   type, status, payment_method, tax_year, description, created_at)
select
  a.beautician_id, a.id, a.client_id, a.treatment_id,
  greatest(0, coalesce(a.price_cents,0)
       - case when a.deposit_paid then coalesce(a.deposit_cents,0) else 0 end) as amount_cents,
  'payment', 'completed', null,
  case
    when (extract(month from d.dt) > 4)
      or (extract(month from d.dt) = 4 and extract(day from d.dt) >= 6)
      then extract(year from d.dt)::int::text || '-'
           || lpad(((extract(year from d.dt)::int + 1) % 100)::text, 2, '0')
    else (extract(year from d.dt)::int - 1)::text || '-'
           || lpad((extract(year from d.dt)::int % 100)::text, 2, '0')
  end as tax_year,
  'Appointment takings (backfill)',
  d.dt as created_at
from appointments a
cross join lateral (select coalesce(a.completed_at, a.ends_at, a.starts_at) as dt) d
where a.status='completed'
  and coalesce(a.price_cents,0) > 0
  and greatest(0, coalesce(a.price_cents,0)
       - case when a.deposit_paid then coalesce(a.deposit_cents,0) else 0 end) > 0
  and not exists (select 1 from transactions t
                  where t.appointment_id=a.id and t.type in ('payment','full_payment'));

-- UNDO (only if ever needed): delete from transactions
--   where description = 'Appointment takings (backfill)';
