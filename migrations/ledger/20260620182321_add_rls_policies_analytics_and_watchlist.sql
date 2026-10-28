-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260620182321, name add_rls_policies_analytics_and_watchlist. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.


-- Analytics tables: backend-populated, no user ownership — public read only.
-- service_role bypasses RLS for all backend writes.

CREATE POLICY "anon_read" ON public.fixture_predictions
  FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "anon_read" ON public.head_to_head
  FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "anon_read" ON public.model_probabilities
  FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "anon_read" ON public.odds_snapshots
  FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "anon_read" ON public.performance_summary
  FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "anon_read" ON public.recent_form
  FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "anon_read" ON public.recommendations
  FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "anon_read" ON public.team_stats_cache
  FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "anon_read" ON public.value_signals
  FOR SELECT TO anon, authenticated USING (true);

-- Watchlist: session-based (no auth.uid()), non-sensitive data — full anon CRUD.
-- Session isolation is enforced at the application layer via session_id filtering.
CREATE POLICY "anon_all" ON public.watchlist
  FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

