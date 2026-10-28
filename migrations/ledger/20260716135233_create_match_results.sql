-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260716135233, name create_match_results. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.


CREATE TABLE IF NOT EXISTS match_results (
  id          BIGSERIAL PRIMARY KEY,
  div         TEXT NOT NULL,          -- E0/E1/E2/E3/EC
  season      TEXT NOT NULL,          -- e.g. '2024/25'
  match_date  DATE NOT NULL,
  match_time  TEXT,
  home_team   TEXT NOT NULL,
  away_team   TEXT NOT NULL,
  fthg        SMALLINT,               -- Full-time home goals
  ftag        SMALLINT,               -- Full-time away goals
  ftr         CHAR(1),                -- H/D/A
  hthg        SMALLINT,               -- Half-time home goals
  htag        SMALLINT,               -- Half-time away goals
  htr         CHAR(1),                -- Half-time result
  referee     TEXT,
  hs          SMALLINT,               -- Home shots
  as_         SMALLINT,               -- Away shots (AS is reserved)
  hst         SMALLINT,               -- Home shots on target
  ast         SMALLINT,               -- Away shots on target
  hf          SMALLINT,               -- Home fouls
  af          SMALLINT,               -- Away fouls
  hc          SMALLINT,               -- Home corners
  ac          SMALLINT,               -- Away corners
  hy          SMALLINT,               -- Home yellows
  ay          SMALLINT,               -- Away yellows
  hr          SMALLINT,               -- Home reds
  ar          SMALLINT,               -- Away reds
  odds        JSONB,                  -- All bookmaker odds columns
  source_file TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (div, match_date, home_team, away_team)
);

CREATE INDEX IF NOT EXISTS idx_match_results_div       ON match_results (div);
CREATE INDEX IF NOT EXISTS idx_match_results_season    ON match_results (season);
CREATE INDEX IF NOT EXISTS idx_match_results_date      ON match_results (match_date);
CREATE INDEX IF NOT EXISTS idx_match_results_home      ON match_results (home_team);
CREATE INDEX IF NOT EXISTS idx_match_results_away      ON match_results (away_team);
CREATE INDEX IF NOT EXISTS idx_match_results_odds      ON match_results USING GIN (odds);

