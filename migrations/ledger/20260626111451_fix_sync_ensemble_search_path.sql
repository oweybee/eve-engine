-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260626111451, name fix_sync_ensemble_search_path. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.


ALTER FUNCTION public.sync_ensemble_probs_to_computed_values()
  SET search_path = public, pg_catalog;

