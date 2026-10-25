-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260626111409, name add_service_role_policies_backend_tables. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.


CREATE POLICY "edge_signals_service_role"
  ON public.edge_signals FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY "fixture_mapping_service_role"
  ON public.fixture_mapping FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY "posted_signals_service_role"
  ON public.posted_signals FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY "team_stats_service_role"
  ON public.team_stats FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

