-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260731120926, name lock_down_match_results. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

-- SECURITY: match_results was exposed via PostgREST with RLS disabled and full
-- table privileges granted to anon/authenticated — anyone with the public key
-- could rewrite match results, corrupting settlement, the public track record,
-- and user bet P&L. Results are public sports data: expose read-only.
-- The engine writes via the service-role key, which bypasses RLS and keeps
-- its own privileges.

begin;

alter table public.match_results enable row level security;

drop policy if exists "public_read_match_results" on public.match_results;
create policy "public_read_match_results" on public.match_results
  for select to anon, authenticated
  using (true);

-- Belt and braces: strip client write privileges entirely.
revoke insert, update, delete, truncate, references, trigger
  on public.match_results from anon, authenticated;

commit;
