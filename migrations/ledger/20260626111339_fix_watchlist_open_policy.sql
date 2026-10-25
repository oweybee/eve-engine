-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260626111339, name fix_watchlist_open_policy. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.


-- watchlist uses session_id (no auth.uid), so we can't scope by user identity.
-- Drop the open anon_all policy and restrict to service_role only until
-- proper user auth is implemented.
DROP POLICY IF EXISTS anon_all ON public.watchlist;

CREATE POLICY "watchlist_service_role_only"
  ON public.watchlist FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

