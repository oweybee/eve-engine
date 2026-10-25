-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260625115545, name create_lineups. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

-- Confirmed team lineups, polled every minute in the 90-min pre-kickoff window.
-- starting_xi and substitutes stored as JSONB arrays.

CREATE TABLE IF NOT EXISTS lineups (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  fixture_id                text        NOT NULL,
  api_football_fixture_id   integer,
  team_id                   integer     NOT NULL,
  team_name                 text        NOT NULL,
  formation                 text,
  starting_xi               jsonb       NOT NULL DEFAULT '[]',
  substitutes               jsonb       NOT NULL DEFAULT '[]',
  confirmed                 boolean     NOT NULL DEFAULT false,
  fetched_at                timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_lineups_fixture_team UNIQUE (fixture_id, team_id)
);

CREATE INDEX IF NOT EXISTS idx_lineups_fixture ON lineups (fixture_id);
