-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260706115922, name portal_core_schema. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

-- =============================================================================
-- MaxEdge User Portal — "My Bets" & Bankroll Tracker
-- Core schema: profiles, preferences, bets, bankroll_transactions, user_bookmakers
-- All user-owned tables are RLS-locked to auth.uid(). Backend keeps service_role.
-- =============================================================================

-- ── profiles ────────────────────────────────────────────────────────────────
create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  email         text,
  tier          text not null default 'free'
                  check (tier in ('free','starter','edge','pro')),
  status        text not null default 'active',
  created_at    timestamptz not null default now()
);
alter table public.profiles enable row level security;

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select to authenticated using (auth.uid() = id);
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);
drop policy if exists profiles_service on public.profiles;
create policy profiles_service on public.profiles
  for all to service_role using (true) with check (true);

-- ── preferences ─────────────────────────────────────────────────────────────
create table if not exists public.preferences (
  user_id             uuid primary key references auth.users(id) on delete cascade,
  odds_format         text not null default 'decimal' check (odds_format in ('decimal','fractional')),
  timezone            text not null default 'Europe/London',
  currency            text not null default 'GBP',
  staking_plan        text not null default 'flat' check (staking_plan in ('flat','percent','kelly')),
  default_stake_value numeric not null default 10,
  min_edge            numeric not null default 0,
  min_mes             integer not null default 0,
  favourite_leagues   text[] not null default '{}',
  starting_bankroll   numeric not null default 1000,
  alert_config        jsonb not null default '{}'::jsonb,
  updated_at          timestamptz not null default now()
);
alter table public.preferences enable row level security;

drop policy if exists preferences_own on public.preferences;
create policy preferences_own on public.preferences
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists preferences_service on public.preferences;
create policy preferences_service on public.preferences
  for all to service_role using (true) with check (true);

-- ── bets ────────────────────────────────────────────────────────────────────
create table if not exists public.bets (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  source          text not null default 'manual' check (source in ('maxedge','manual')),
  signal_id       uuid,                       -- links to originating value_signals row (CLV)
  competition     text,
  match_id        uuid references public.matches(id) on delete set null,
  match_label     text,                       -- free-text fallback / display label
  kickoff_at      timestamptz,
  market          text not null default 'h2h' check (market in ('h2h','totals','btts','corners','cards')),
  selection       text not null,              -- home/draw/away/over/under/btts_yes/btts_no/...
  market_line     numeric,
  odds_taken      numeric not null check (odds_taken > 1),
  bookmaker       text,
  stake           numeric not null default 0 check (stake >= 0),
  mes_at_record   integer,
  edge_at_record  numeric,
  model_tag       text,
  closing_odds    numeric,
  clv             numeric,
  status          text not null default 'open'
                    check (status in ('open','won','lost','void','cashout')),
  returned_amount numeric,                    -- cashout / partial settle payout
  settled_at      timestamptz,
  settle_mode     text check (settle_mode in ('auto','manual')),
  is_acca         boolean not null default false,
  acca_group_id   uuid,
  created_at      timestamptz not null default now()
);
alter table public.bets enable row level security;

create index if not exists bets_user_status_idx on public.bets(user_id, status);
create index if not exists bets_user_created_idx on public.bets(user_id, created_at desc);
create index if not exists bets_match_idx on public.bets(match_id);

drop policy if exists bets_own on public.bets;
create policy bets_own on public.bets
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists bets_service on public.bets;
create policy bets_service on public.bets
  for all to service_role using (true) with check (true);

-- ── bankroll_transactions ───────────────────────────────────────────────────
create table if not exists public.bankroll_transactions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  type        text not null check (type in ('deposit','withdrawal','adjustment')),
  amount      numeric not null,               -- signed: deposits +, withdrawals -
  occurred_at timestamptz not null default now(),
  note        text,
  created_at  timestamptz not null default now()
);
alter table public.bankroll_transactions enable row level security;

create index if not exists bankroll_user_idx on public.bankroll_transactions(user_id, occurred_at);

drop policy if exists bankroll_own on public.bankroll_transactions;
create policy bankroll_own on public.bankroll_transactions
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists bankroll_service on public.bankroll_transactions;
create policy bankroll_service on public.bankroll_transactions
  for all to service_role using (true) with check (true);

-- ── user_bookmakers ─────────────────────────────────────────────────────────
create table if not exists public.user_bookmakers (
  user_id      uuid not null references auth.users(id) on delete cascade,
  bookmaker    text not null,
  is_preferred boolean not null default true,
  is_limited   boolean not null default false,
  limited_at   timestamptz,
  primary key (user_id, bookmaker)
);
alter table public.user_bookmakers enable row level security;

drop policy if exists user_bookmakers_own on public.user_bookmakers;
create policy user_bookmakers_own on public.user_bookmakers
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists user_bookmakers_service on public.user_bookmakers;
create policy user_bookmakers_service on public.user_bookmakers
  for all to service_role using (true) with check (true);
