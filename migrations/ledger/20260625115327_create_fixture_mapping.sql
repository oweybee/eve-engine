-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260625115327, name create_fixture_mapping. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

CREATE TABLE IF NOT EXISTS fixture_mapping (
  odds_api_event_id         text        PRIMARY KEY,
  api_football_fixture_id   integer,
  home_team                 text        NOT NULL,
  away_team                 text        NOT NULL,
  kickoff_at                timestamptz NOT NULL,
  created_at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fixture_mapping_kickoff
  ON fixture_mapping (kickoff_at);

CREATE INDEX IF NOT EXISTS idx_fixture_mapping_afid
  ON fixture_mapping (api_football_fixture_id)
  WHERE api_football_fixture_id IS NOT NULL;
