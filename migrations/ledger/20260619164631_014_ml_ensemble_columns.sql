-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260619164631, name 014_ml_ensemble_columns. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

-- Migration 014: ML Ensemble Engine support columns

ALTER TABLE matches
  ADD COLUMN IF NOT EXISTS goals_home         SMALLINT   DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS goals_away         SMALLINT   DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS xg_home            NUMERIC(5,3) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS xg_away            NUMERIC(5,3) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS xg_conceded_home   NUMERIC(5,3) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS xg_conceded_away   NUMERIC(5,3) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS shots_home         SMALLINT   DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS shots_away         SMALLINT   DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS shots_on_target_home SMALLINT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS shots_on_target_away SMALLINT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS ppda_home          NUMERIC(6,3) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS ppda_away          NUMERIC(6,3) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS result             TEXT       DEFAULT NULL CHECK (result IN ('home','draw','away')),
  ADD COLUMN IF NOT EXISTS stats_source       TEXT       DEFAULT NULL;

ALTER TABLE computed_values
  ADD COLUMN IF NOT EXISTS model_architecture TEXT       DEFAULT 'DIXON_COLES'
    CHECK (model_architecture IN ('DIXON_COLES','ML_ENSEMBLE')),
  ADD COLUMN IF NOT EXISTS ensemble_home_prob  NUMERIC(8,6) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS ensemble_draw_prob  NUMERIC(8,6) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS ensemble_away_prob  NUMERIC(8,6) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS ensemble_over_prob  NUMERIC(8,6) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS ensemble_btts_prob  NUMERIC(8,6) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS feature_completeness NUMERIC(4,3) DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_cv_architecture
  ON computed_values (match_id, model_architecture);

CREATE INDEX IF NOT EXISTS idx_matches_result
  ON matches (result, kickoff_at)
  WHERE result IS NOT NULL;

CREATE TABLE IF NOT EXISTS team_stats_cache (
  id             BIGSERIAL PRIMARY KEY,
  team_id        UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  roll_window    SMALLINT NOT NULL CHECK (roll_window IN (5, 10)),
  as_of          DATE NOT NULL,
  games_played   SMALLINT NOT NULL DEFAULT 0,
  xg_created     NUMERIC(6,3) DEFAULT NULL,
  goals_scored   NUMERIC(5,2) DEFAULT NULL,
  shots_per_game NUMERIC(5,2) DEFAULT NULL,
  sot_ratio      NUMERIC(5,4) DEFAULT NULL,
  xg_conceded    NUMERIC(6,3) DEFAULT NULL,
  goals_conceded NUMERIC(5,2) DEFAULT NULL,
  ppda_index     NUMERIC(6,3) DEFAULT NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (team_id, roll_window, as_of)
);

CREATE INDEX IF NOT EXISTS idx_team_stats_lookup
  ON team_stats_cache (team_id, roll_window, as_of DESC);
