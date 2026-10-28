-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20261025222242, name free_pick_candidates_server_only. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

revoke execute on function public.free_pick_candidates(integer) from public, anon, authenticated;
grant execute on function public.free_pick_candidates(integer) to service_role;
