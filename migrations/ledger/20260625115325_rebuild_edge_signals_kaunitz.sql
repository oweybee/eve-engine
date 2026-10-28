-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260625115325, name rebuild_edge_signals_kaunitz. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

DROP TABLE IF EXISTS edge_signals;

CREATE TABLE edge_signals (
  id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  fixture_id      text         NOT NULL,
  outcome         text         NOT NULL CHECK (outcome IN ('home', 'draw', 'away')),
  p_cons          numeric(6,4) NOT NULL,
  p_fair_kaunitz  numeric(6,4) NOT NULL,
  p_fair_betfair  numeric(6,4),
  edge_kaunitz    numeric(6,4) NOT NULL,
  edge_betfair    numeric(6,4),
  bookmaker_count smallint     NOT NULL,
  signals_agree   boolean      NOT NULL DEFAULT false,
  tier            text         CHECK (tier IN ('RUBY', 'VALUE')),
  computed_at     timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT uq_edge_signals_fixture_outcome UNIQUE (fixture_id, outcome)
);

CREATE INDEX IF NOT EXISTS idx_edge_signals_tier
  ON edge_signals (tier) WHERE tier IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_edge_signals_computed_at
  ON edge_signals (computed_at DESC);
