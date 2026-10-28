-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260625103414, name create_edge_signals. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

CREATE TABLE IF NOT EXISTS edge_signals (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  fixture_id      text        NOT NULL,
  outcome         text        NOT NULL CHECK (outcome IN ('home', 'draw', 'away')),
  fair_prob_betfair numeric(6,4) NOT NULL,
  fair_prob_dc    numeric(6,4) NOT NULL,
  edge_betfair    numeric(6,4) NOT NULL,
  edge_dc         numeric(6,4) NOT NULL,
  signals_agree   boolean     NOT NULL DEFAULT false,
  tier            text        CHECK (tier IN ('RUBY', 'VALUE')),
  computed_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_edge_signals_fixture_outcome UNIQUE (fixture_id, outcome)
);

CREATE INDEX IF NOT EXISTS idx_edge_signals_tier
  ON edge_signals (tier)
  WHERE tier IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_edge_signals_computed_at
  ON edge_signals (computed_at DESC);
