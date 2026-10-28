-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260706120051, name portal_lock_trigger_fn. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

-- The signup trigger fn must not be REST-callable; it only runs as a trigger.
revoke execute on function public.handle_new_portal_user() from public;
revoke execute on function public.handle_new_portal_user() from anon;
revoke execute on function public.handle_new_portal_user() from authenticated;
-- settle_my_bets: authenticated-only (intentional); ensure anon has none.
revoke execute on function public.settle_my_bets() from anon;
