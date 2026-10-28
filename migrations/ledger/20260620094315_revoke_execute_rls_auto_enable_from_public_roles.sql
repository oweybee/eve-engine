-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260620094315, name revoke_execute_rls_auto_enable_from_public_roles. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.


-- rls_auto_enable() is an event trigger function; it should never be callable
-- directly by API users. Revoke the public grants added by default.
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM anon, authenticated, public;

