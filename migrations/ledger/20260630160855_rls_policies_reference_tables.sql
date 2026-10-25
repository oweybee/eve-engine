-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260630160855, name rls_policies_reference_tables. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

CREATE TABLE IF NOT EXISTS suggested_accas (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy      text NOT NULL,
  acca_date     date NOT NULL,
  signal_ids    uuid[] NOT NULL,
  leg_count     integer NOT NULL,
  combined_odds numeric NOT NULL,
  combined_prob numeric,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT suggested_accas_strategy_acca_date_key UNIQUE (strategy, acca_date)
);

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
