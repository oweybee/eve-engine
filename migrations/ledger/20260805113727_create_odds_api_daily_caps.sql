-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260805113727, name create_odds_api_daily_caps. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

create table public.odds_api_daily_caps (
  date date primary key,
  scheduled_matches integer not null,
  credit_cap integer not null,
  credits_per_match numeric not null,
  floor_applied boolean not null default false,
  ceiling_applied boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.odds_api_daily_caps enable row level security;

