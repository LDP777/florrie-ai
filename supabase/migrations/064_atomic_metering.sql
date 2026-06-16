-- 064_atomic_metering.sql
-- Atomic increments for message_usage + sms_usage.
--
-- Why: the app previously did a read-modify-write in JS (read the row, add 1 in
-- Node, write it back). Concurrent sends (the nudge engines fan out over many
-- clients) could read the same row and both write n+1, losing a count and
-- drifting overage_total_pence, which is exactly the field monthly billing
-- charges from. These functions move the increment into a single atomic SQL
-- UPDATE so no count is ever lost.
--
-- Safe to apply anytime: the app calls these via supabase.rpc() and falls back
-- to the old non-atomic path automatically if the function is not present, so
-- nothing breaks before this migration runs.

-- Combined monthly quota (SMS + WhatsApp), the billing source of truth.
create or replace function increment_message_usage(
  p_beautician_id uuid,
  p_month date,
  p_free_limit integer,
  p_channel text,          -- 'sms' or 'whatsapp'
  p_overage_pence integer
) returns public.message_usage
language plpgsql
as $$
declare
  result public.message_usage;
begin
  -- Ensure the row exists (no-op if a concurrent call already created it).
  insert into public.message_usage (beautician_id, month, free_limit, sms_sent, whatsapp_sent)
  values (p_beautician_id, p_month, p_free_limit, 0, 0)
  on conflict (beautician_id, month) do nothing;

  -- Single atomic update. Overage is decided on the PRE-increment total
  -- (sms_sent + whatsapp_sent) against the current tier limit, matching the
  -- previous JS semantics.
  update public.message_usage u
  set
    free_limit = p_free_limit,
    sms_sent = u.sms_sent + (case when p_channel = 'sms' then 1 else 0 end),
    whatsapp_sent = u.whatsapp_sent + (case when p_channel = 'whatsapp' then 1 else 0 end),
    overage_sms_count = coalesce(u.overage_sms_count, 0) + (case when p_channel = 'sms' and (u.sms_sent + u.whatsapp_sent) >= p_free_limit then 1 else 0 end),
    overage_wa_count = coalesce(u.overage_wa_count, 0) + (case when p_channel = 'whatsapp' and (u.sms_sent + u.whatsapp_sent) >= p_free_limit then 1 else 0 end),
    overage_sms_pence = coalesce(u.overage_sms_pence, 0) + (case when p_channel = 'sms' and (u.sms_sent + u.whatsapp_sent) >= p_free_limit then p_overage_pence else 0 end),
    overage_wa_pence = coalesce(u.overage_wa_pence, 0) + (case when p_channel = 'whatsapp' and (u.sms_sent + u.whatsapp_sent) >= p_free_limit then p_overage_pence else 0 end),
    overage_total_pence = coalesce(u.overage_total_pence, 0) + (case when (u.sms_sent + u.whatsapp_sent) >= p_free_limit then p_overage_pence else 0 end),
    updated_at = now()
  where u.beautician_id = p_beautician_id and u.month = p_month
  returning u.* into result;

  return result;
end;
$$;

-- Legacy weekly SMS meter (display/legacy). Overage uses the POST-increment
-- count strictly greater than the free limit, matching the previous JS.
create or replace function increment_sms_usage(
  p_beautician_id uuid,
  p_week_start date,
  p_free_limit integer,
  p_surplus_pence integer
) returns public.sms_usage
language plpgsql
as $$
declare
  result public.sms_usage;
  new_surplus integer;
begin
  insert into public.sms_usage (beautician_id, week_start, messages_sent, surplus_count, surplus_total_pence)
  values (p_beautician_id, p_week_start, 0, 0, 0)
  on conflict (beautician_id, week_start) do nothing;

  update public.sms_usage u
  set
    messages_sent = u.messages_sent + 1,
    surplus_count = case when (u.messages_sent + 1) > p_free_limit then coalesce(u.surplus_count, 0) + 1 else coalesce(u.surplus_count, 0) end,
    surplus_total_pence = (case when (u.messages_sent + 1) > p_free_limit then coalesce(u.surplus_count, 0) + 1 else coalesce(u.surplus_count, 0) end) * p_surplus_pence,
    updated_at = now()
  where u.beautician_id = p_beautician_id and u.week_start = p_week_start
  returning u.* into result;

  return result;
end;
$$;
