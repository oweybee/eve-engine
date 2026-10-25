-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260706212246, name portal_lock_cap_trigger_fn. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

-- The cap trigger fn only runs as a trigger; it must not be REST-callable.
revoke execute on function public.enforce_free_bet_cap() from public, anon, authenticated;
