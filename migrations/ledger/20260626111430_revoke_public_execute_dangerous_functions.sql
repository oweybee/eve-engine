-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260626111430, name revoke_public_execute_dangerous_functions. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.


-- Postgres grants EXECUTE to PUBLIC by default, so revoking named roles alone
-- is insufficient — the PUBLIC grant remains and all roles inherit it.
-- Revoke from PUBLIC first, then grant back only to service_role.

REVOKE EXECUTE
  ON FUNCTION public.settle_match_signals(uuid)
  FROM PUBLIC;

GRANT EXECUTE
  ON FUNCTION public.settle_match_signals(uuid)
  TO service_role;

REVOKE EXECUTE
  ON FUNCTION public.sync_ensemble_probs_to_computed_values()
  FROM PUBLIC;

GRANT EXECUTE
  ON FUNCTION public.sync_ensemble_probs_to_computed_values()
  TO service_role;

