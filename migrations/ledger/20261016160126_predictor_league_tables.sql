-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20261016160126, name predictor_league_tables. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

create table if not exists public.predictor_rounds (
  id serial primary key, label text not null, league_id uuid not null references public.leagues(id),
  first_kickoff timestamptz not null, last_kickoff timestamptz not null,
  status text not null default 'open' check (status in ('open','final')),
  announced_at timestamptz, reminded_at timestamptz, finalised_at timestamptz,
  winner_ids text[] not null default '{}', created_at timestamptz not null default now());
create table if not exists public.predictor_fixtures (
  round_id int not null references public.predictor_rounds(id) on delete cascade,
  match_id uuid not null references public.matches(id), slot smallint not null,
  primary key (round_id, match_id), unique (round_id, slot));
create unique index if not exists predictor_fixtures_match_once on public.predictor_fixtures(match_id);
create table if not exists public.predictor_entries (
  round_id int not null references public.predictor_rounds(id) on delete cascade,
  match_id uuid not null references public.matches(id),
  discord_user_id text not null, discord_name text not null,
  home smallint not null check (home between 0 and 20), away smallint not null check (away between 0 and 20),
  updated_at timestamptz not null default now(),
  primary key (round_id, match_id, discord_user_id),
  foreign key (round_id, match_id) references public.predictor_fixtures(round_id, match_id) on delete cascade);
alter table public.predictor_rounds enable row level security;
alter table public.predictor_fixtures enable row level security;
alter table public.predictor_entries enable row level security;
