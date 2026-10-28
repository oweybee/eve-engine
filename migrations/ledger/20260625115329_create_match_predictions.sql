-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260625115329, name create_match_predictions. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

CREATE TABLE IF NOT EXISTS match_predictions (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  fixture_id                text        NOT NULL UNIQUE,
  api_football_fixture_id   integer,
  winner_team               text,
  winner_comment            text,
  under_over                text,
  goals_home                text,
  goals_away                text,
  advice                    text,
  pct_home                  text,
  pct_draw                  text,
  pct_away                  text,
  fetched_at                timestamptz NOT NULL DEFAULT now()
);
