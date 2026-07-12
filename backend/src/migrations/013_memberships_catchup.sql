-- 013_memberships_catchup.sql
--
-- Schema drift catch-up for the membership tables, which were created ad hoc in
-- the dashboard and never had a migration file. Idempotent: safe to re-run, and
-- safe against the live database where both tables already exist with data.
--
-- Naming, because it is genuinely confusing and has already caused one bug:
--   client_memberships       = the PLANS Ellie offers   (name, price, benefits)
--   membership_subscriptions = the ENROLMENTS           (which client is on which plan)
--
-- There is NO `membership_plans` table. booking.js used to query one, plus
-- client_id/status columns that do not exist on client_memberships, so the
-- public booking page could never recognise a member. Fixed in the same commit
-- as this file.

-- The plans a beautician offers.
create table if not exists client_memberships (
  id           uuid primary key default uuid_generate_v4(),
  beautician_id uuid not null references beauticians(id) on delete cascade,
  name         text not null,
  description  text,
  price_cents  integer not null default 0,
  benefits     jsonb default '[]'::jsonb,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Which client is signed up to which plan.
create table if not exists membership_subscriptions (
  id              uuid primary key default uuid_generate_v4(),
  beautician_id   uuid not null references beauticians(id) on delete cascade,
  client_id       uuid not null references clients(id) on delete cascade,
  membership_id   uuid not null references client_memberships(id) on delete cascade,
  status          text not null default 'active',
  started_at      timestamptz,
  next_billing_at timestamptz,
  cancelled_at    timestamptz,
  created_at      timestamptz not null default now()
);

create index if not exists idx_client_memberships_beautician
  on client_memberships (beautician_id);

-- The member lookup on the booking page filters on exactly these three.
create index if not exists idx_membership_subscriptions_lookup
  on membership_subscriptions (beautician_id, client_id, status);

alter table client_memberships       enable row level security;
alter table membership_subscriptions enable row level security;
