-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20261016154842, name bt_snap_16oct. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

create table if not exists public.bt_snap_16oct (
  match_id uuid not null references public.matches(id) on delete cascade,
  bookmaker text not null, market text not null, market_line numeric,
  home_odds numeric, draw_odds numeric, away_odds numeric,
  snapshot_at timestamptz,
  constraint bt_snap_16oct_key unique nulls not distinct (match_id, bookmaker, market, market_line)
);
alter table public.bt_snap_16oct enable row level security;
comment on table public.bt_snap_16oct is 'One-off research (16 Oct 2026): API-Football last pre-match odds snapshot for fixtures completed in the previous 7 days, for backtesting DC/DNB/AH/corners/cards. Safe to drop.';
