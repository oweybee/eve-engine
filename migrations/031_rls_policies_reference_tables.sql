-- 031_rls_policies_reference_tables.sql
--
-- HIGH FIX: three tables had RLS ENABLED but ZERO policies, so the frontend
-- (anon / authenticated keys) silently received empty result sets while the
-- engine (service_role, which bypasses RLS) kept writing to them:
--
--   * team_statistics  — feeds the match-detail "Team Stats" panel
--   * referee_stats    — feeds the referee card-tendency display
--   * suggested_accas  — the daily suggested-accumulator ledger shown to users
--
-- All three are read-only reference data for clients, so each gets the same
-- public-read policy already used by value_signals, performance_summary,
-- recommendations, etc.: SELECT for anon + authenticated, writes restricted to
-- the service role (the default deny under RLS).
--
-- suggested_accas was created out-of-band (no prior migration), so this file
-- also creates it idempotently to keep fresh deployments self-consistent.
-- Schema mirrors the live table written by recordAccas.js.
--
-- Idempotent and safe to re-run.

-- ---------------------------------------------------------------------------
-- suggested_accas: daily forward-test ledger of suggested accumulators
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS suggested_accas (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy      text NOT NULL,                 -- e.g. 'edge'
  acca_date     date NOT NULL,                 -- UTC day the acca was recorded
  signal_ids    uuid[] NOT NULL,               -- value_signals legs
  leg_count     integer NOT NULL,
  combined_odds numeric NOT NULL,
  combined_prob numeric,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT suggested_accas_strategy_acca_date_key UNIQUE (strategy, acca_date)
);

-- ---------------------------------------------------------------------------
-- Enable RLS + public-read policies
-- ---------------------------------------------------------------------------
ALTER TABLE team_statistics ENABLE ROW LEVEL SECURITY;
ALTER TABLE referee_stats   ENABLE ROW LEVEL SECURITY;
ALTER TABLE suggested_accas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS anon_read ON team_statistics;
CREATE POLICY anon_read ON team_statistics
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS anon_read ON referee_stats;
CREATE POLICY anon_read ON referee_stats
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS anon_read ON suggested_accas;
CREATE POLICY anon_read ON suggested_accas
  FOR SELECT TO anon, authenticated USING (true);
