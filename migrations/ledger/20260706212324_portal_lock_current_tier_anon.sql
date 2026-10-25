-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260706212324, name portal_lock_current_tier_anon. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

-- current_tier is only used by authenticated-scoped RLS on bets; anon never
-- evaluates those policies, so it doesn't need execute.
revoke execute on function public.current_tier() from anon;
