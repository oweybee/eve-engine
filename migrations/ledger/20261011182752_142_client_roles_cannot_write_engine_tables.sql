-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20261011182752, name 142_client_roles_cannot_write_engine_tables. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

-- RLS never applies to TRUNCATE, so these grants let a logged-out visitor
-- (anon) or any signed-up user (authenticated) empty engine tables.
-- None of these tables has a write policy, so no client path loses anything:
-- the engine writes with service_role. SELECT is left exactly as it was.
revoke insert, update, delete, truncate, references, trigger
  on public.price_freshness_policy,
     public.inplay_line_value,
     public.odds_latest_expired,
     public.odds_refresh_runs,
     public.engine_runs,
     public.pipeline_heartbeat,
     public.league_refresh_scope,
     public.refresh_tier_occupancy
  from anon, authenticated;
