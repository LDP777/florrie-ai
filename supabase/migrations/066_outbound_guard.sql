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
