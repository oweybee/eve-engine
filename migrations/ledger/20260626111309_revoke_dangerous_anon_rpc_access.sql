-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260626111309, name revoke_dangerous_anon_rpc_access. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.


REVOKE EXECUTE
  ON FUNCTION public.settle_match_signals(uuid)
  FROM anon, authenticated;

REVOKE EXECUTE
  ON FUNCTION public.sync_ensemble_probs_to_computed_values()
  FROM anon, authenticated;

