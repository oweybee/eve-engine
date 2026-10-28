-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20261010095614, name value_signals_price_status_columns. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.


set local lock_timeout = '4s';
alter table public.value_signals
  add column if not exists price_status text,
  add column if not exists price_checked_at timestamptz,
  add column if not exists live_best_odds numeric,
  add column if not exists live_edge numeric;

