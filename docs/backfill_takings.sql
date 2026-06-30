-- ONE-TIME back-fill: write the missing takings for completed, priced
-- appointments that never got an income row (the reason the Money page read low).
-- APPLIED 2026-06-30 via Supabase SQL editor: 46 rows, £1,772.50 recovered.
--
-- NOTE: the transactions table has NO `treatment_id` or `description` column
-- (real cols: id, beautician_id, appointment_id, amount_cents, type,
--  stripe_payment_intent_id, stripe_charge_id, payment_method, status, tax_year,
--  created_at, accounting_synced, accounting_invoice_id, client_id). An earlier
-- version of this file referenced treatment_id+description and errored; this is
-- the corrected, working version. Idempotent (NOT EXISTS guard). Paste into the
-- Supabase SQL editor; STEP 1 changes nothing, run it first.

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

-- STEP 2 - THE BACK-FILL. Safe to re-run; the guard skips anything already logged.
-- Add `returning id;` if you want the inserted ids back as an undo handle.
insert into transactions
  (beautician_id, appointment_id, client_id, amount_cents,
   type, status, payment_method, tax_year, created_at)
select
  a.beautician_id, a.id, a.client_id,
  greatest(0, coalesce(a.price_cents,0)
       - case when a.deposit_paid then coalesce(a.deposit_cents,0) else 0 end),
  'payment', 'completed', null,
  case
    when (extract(month from d.dt) > 4)
      or (extract(month from d.dt) = 4 and extract(day from d.dt) >= 6)
      then extract(year from d.dt)::int::text || '-'
           || lpad(((extract(year from d.dt)::int + 1) % 100)::text, 2, '0')
    else (extract(year from d.dt)::int - 1)::text || '-'
           || lpad((extract(year from d.dt)::int % 100)::text, 2, '0')
  end,
  d.dt
from appointments a
cross join lateral (select coalesce(a.completed_at, a.ends_at, a.starts_at) as dt) d
where a.status='completed'
  and coalesce(a.price_cents,0) > 0
  and greatest(0, coalesce(a.price_cents,0)
       - case when a.deposit_paid then coalesce(a.deposit_cents,0) else 0 end) > 0
  and not exists (select 1 from transactions t
                  where t.appointment_id=a.id and t.type in ('payment','full_payment'));
