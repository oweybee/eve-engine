-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20261010095950, name withhold_unconfirmed_prices_policy. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

set local lock_timeout = '4s';
create policy withhold_unconfirmed_prices on public.value_signals
  as restrictive for select
  using (coalesce(price_status,'live') not in ('stale','shrunk','edge_gone')
         or coalesce(result,'pending') <> 'pending'
         or kickoff_at <= now());
