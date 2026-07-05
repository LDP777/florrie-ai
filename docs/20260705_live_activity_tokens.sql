-- Live Activity ("Florrie on the desk") push tokens. Each running activity on a
-- device registers its APNs push token here; the backend pushes content-state
-- updates to it. Retired by setting ended_at.
create table if not exists live_activity_tokens (
  id uuid primary key default gen_random_uuid(),
  beautician_id uuid not null references beauticians(id) on delete cascade,
  activity_id text,
  push_token text not null unique,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_live_activity_tokens_active
  on live_activity_tokens(beautician_id) where ended_at is null;
