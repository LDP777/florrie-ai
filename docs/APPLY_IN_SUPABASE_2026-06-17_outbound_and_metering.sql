-- =============================================================
-- Paste this WHOLE file into the Supabase SQL editor and Run.
-- It applies migrations 064 + 065 + 066 in order. Safe to run once.
-- Generated 2026-06-17.
-- =============================================================

-- ===== 064_atomic_metering.sql =====
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

-- ===== 065_reminder_unique.sql =====
-- 065_reminder_unique.sql
-- Make "one 24h reminder per appointment, ever" a hard database guarantee.
--
-- notifications.notifyReminder24h now inserts the ai_actions marker FIRST and
-- treats a unique-violation (23505) as "already reminded". This partial unique
-- index is what makes that insert-first dedupe atomic and race-proof: two
-- overlapping reminder runs can no longer both insert a marker for the same
-- appointment.
--
-- The partial WHERE scopes the constraint to reminder markers only, so every
-- other action_type (and any rows with a null appointment_id) is unaffected.

create unique index if not exists ai_actions_one_reminder_per_appt
  on public.ai_actions (appointment_id)
  where action_type = 'appointment_reminder';

-- ===== 066_outbound_guard.sql =====
-- 066_outbound_guard.sql
-- The outbound-safety layer: one record of every proactive message Florrie wants
-- to send on the beautician's behalf. This is the single source of truth for
-- cross-engine frequency caps and the daily "Florrie's outbox" approval review.
--
-- Transactional messages (confirmations, reminders, replies) are NOT gated and
-- may or may not be logged here; the table exists to control PROACTIVE sends
-- (rebook nudges, comeback, gap-fill, review requests, campaigns) which is where
-- the risk to the client relationship and the message allowance lives.

create table if not exists outbound_sends (
  id uuid primary key default gen_random_uuid(),
  beautician_id uuid not null references beauticians(id) on delete cascade,
  client_id uuid references clients(id) on delete set null,
  message_type text not null,
  tier text not null,                                  -- 'transactional' | 'proactive'
  channel text,                                        -- 'whatsapp' | 'sms' | 'email'
  status text not null default 'pending_approval',     -- pending_approval | approved | sent | blocked | skipped
  reason text,                                         -- why blocked / held / queued
  body text,                                           -- drafted message, for the approval preview
  created_at timestamptz not null default now(),
  decided_at timestamptz
);

create index if not exists outbound_sends_beautician_created
  on outbound_sends (beautician_id, created_at desc);
create index if not exists outbound_sends_client_recent
  on outbound_sends (beautician_id, client_id, created_at desc);
create index if not exists outbound_sends_pending
  on outbound_sends (beautician_id) where status = 'pending_approval';

-- Per-category trust dial. {} = everything proactive asks first (safe default).
-- Ellie can set e.g. {"rebook_nudge":"auto"} once she trusts a category, and
-- {"proactive":"auto"} as a blanket "let Florrie send proactively" switch.
alter table beauticians add column if not exists autonomy jsonb not null default '{}'::jsonb;

-- Positive marketing consent already exists on clients (marketing_consent,
-- marketing_opted_out_at) from earlier migrations; no change needed here.
