-- 034_rls_hardening.sql
-- =============================================================================
-- Security audit follow-up. Two gaps found by comparing tracked migrations
-- against the live schema (project zlbmpeiuhyllxwegtayu):
--
--   1. RLS + read policies for several tables (value_signals, computed_values,
--      matches, odds, recommendations, engine_plan, fixture_predictions,
--      posted_signals, team_elo, team_statistics, referee_stats,
--      inplay_baseline, performance_summary) were applied directly against
--      the live DB and were never captured in this migrations/ directory.
--      The live database is currently correctly locked down (RLS on, no
--      public write policies anywhere — verified via pg_policies), but a
--      fresh environment restored from these tracked migrations alone would
--      NOT reproduce that state. This migration is idempotent and makes it
--      safe to re-run against the already-hardened production database.
--
--   2. `team_elo` and `inplay_baseline` had RLS enabled with zero policies
--      (Supabase advisor: rls_enabled_no_policy). That is a deny-all today,
--      which matches their backend-only (service_role) usage, but an
--      explicit policy documents the intent instead of relying on the
--      absence of a policy.
--
-- Read-only tables get a public SELECT policy (matching how the frontend
-- already consumes them). Nothing here grants INSERT/UPDATE/DELETE to
-- anon/authenticated — all writes continue to go through the service role,
-- which bypasses RLS.
-- =============================================================================

ALTER TABLE value_signals      ENABLE ROW LEVEL SECURITY;
ALTER TABLE computed_values    ENABLE ROW LEVEL SECURITY;
ALTER TABLE matches            ENABLE ROW LEVEL SECURITY;
ALTER TABLE odds               ENABLE ROW LEVEL SECURITY;
ALTER TABLE recommendations    ENABLE ROW LEVEL SECURITY;
ALTER TABLE engine_plan        ENABLE ROW LEVEL SECURITY;
ALTER TABLE fixture_predictions ENABLE ROW LEVEL SECURITY;
ALTER TABLE posted_signals     ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_elo           ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_statistics    ENABLE ROW LEVEL SECURITY;
ALTER TABLE referee_stats      ENABLE ROW LEVEL SECURITY;
ALTER TABLE inplay_baseline    ENABLE ROW LEVEL SECURITY;
ALTER TABLE performance_summary ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "public read value_signals" ON value_signals;
CREATE POLICY "public read value_signals" ON value_signals
  FOR SELECT TO public USING (true);

DROP POLICY IF EXISTS "public read computed_values" ON computed_values;
CREATE POLICY "public read computed_values" ON computed_values
  FOR SELECT TO public USING (true);

DROP POLICY IF EXISTS "public read matches" ON matches;
CREATE POLICY "public read matches" ON matches
  FOR SELECT TO public USING (true);

DROP POLICY IF EXISTS "public read odds" ON odds;
CREATE POLICY "public read odds" ON odds
  FOR SELECT TO public USING (true);

DROP POLICY IF EXISTS "public read recommendations" ON recommendations;
CREATE POLICY "public read recommendations" ON recommendations
  FOR SELECT TO public USING (true);

DROP POLICY IF EXISTS "public read engine_plan" ON engine_plan;
CREATE POLICY "public read engine_plan" ON engine_plan
  FOR SELECT TO public USING (true);

DROP POLICY IF EXISTS "public read fixture_predictions" ON fixture_predictions;
CREATE POLICY "public read fixture_predictions" ON fixture_predictions
  FOR SELECT TO public USING (true);

-- posted_signals is a backend-only dedup ledger — service_role only, no
-- public read (matches the live policy: no SELECT grant to anon/authenticated).
DROP POLICY IF EXISTS "posted_signals_service_role" ON posted_signals;
CREATE POLICY "posted_signals_service_role" ON posted_signals
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Backend-only compute tables: explicit service_role policy instead of a
-- silent deny-all, so intent is documented rather than implicit.
DROP POLICY IF EXISTS "team_elo_service_role" ON team_elo;
CREATE POLICY "team_elo_service_role" ON team_elo
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "inplay_baseline_service_role" ON inplay_baseline;
CREATE POLICY "inplay_baseline_service_role" ON inplay_baseline
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "public read team_statistics" ON team_statistics;
CREATE POLICY "public read team_statistics" ON team_statistics
  FOR SELECT TO public USING (true);

DROP POLICY IF EXISTS "public read referee_stats" ON referee_stats;
CREATE POLICY "public read referee_stats" ON referee_stats
  FOR SELECT TO public USING (true);

DROP POLICY IF EXISTS "public read performance_summary" ON performance_summary;
CREATE POLICY "public read performance_summary" ON performance_summary
  FOR SELECT TO public USING (true);

-- Advisor WARN: function_search_path_mutable. Pin search_path on the
-- updated_at trigger so it can't be redirected by a session-level change.
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$;
