-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260625115332, name create_team_stats. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

CREATE TABLE IF NOT EXISTS team_stats (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id                 integer     NOT NULL,
  team_name               text        NOT NULL,
  league_id               integer     NOT NULL,
  season                  integer     NOT NULL,
  form                    text,
  clean_sheet_home        integer,
  clean_sheet_away        integer,
  clean_sheet_total       integer,
  failed_to_score_home    integer,
  failed_to_score_away    integer,
  failed_to_score_total   integer,
  avg_goals_for_home      numeric(4,2),
  avg_goals_for_away      numeric(4,2),
  avg_goals_against_home  numeric(4,2),
  avg_goals_against_away  numeric(4,2),
  fetched_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_team_stats UNIQUE (team_id, league_id, season)
);

CREATE INDEX IF NOT EXISTS idx_team_stats_team ON team_stats (team_id);
