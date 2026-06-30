-- Migration 027: team statistics + referee tendencies
--
-- Feeds two things:
--   1. The match-detail "Team Stats" panel (form, clean sheets, avg goals/xG,
--      avg corners, avg booking points).
--   2. Data-driven corners & cards models (replacing the hard-coded heuristic
--      team-rate tables) plus a referee card-tendency adjustment.
--
-- Sources (API-Football):
--   /teams/statistics            → form, clean sheet %, failed-to-score %,
--                                  goals for/against avg, cards (→ booking pts)
--   /fixtures + /fixtures/stats   → aggregated avg corners + avg xG over last-N
--   /fixtures (referee field)     → referee name per match, aggregated to rates

CREATE TABLE IF NOT EXISTS team_statistics (
  team_id             BIGINT PRIMARY KEY,        -- API-Football team id
  team_name           TEXT,
  scope               TEXT DEFAULT 'last10',     -- aggregation window label
  form                TEXT,                      -- e.g. 'WWDLW'
  played              INTEGER,
  clean_sheet_pct     NUMERIC,
  failed_to_score_pct NUMERIC,
  goals_for_avg       NUMERIC,
  goals_against_avg   NUMERIC,
  xg_for_avg          NUMERIC,
  xg_against_avg      NUMERIC,
  corners_for_avg     NUMERIC,
  corners_against_avg NUMERIC,
  cards_avg           NUMERIC,                   -- yellow+red per match
  booking_points_avg  NUMERIC,                   -- 10·yellow + 25·red (Betfair convention)
  raw                 JSONB,                     -- full payload for the UI
  updated_at          TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_team_statistics_name ON team_statistics (lower(team_name));

CREATE TABLE IF NOT EXISTS referee_stats (
  referee_name        TEXT PRIMARY KEY,
  matches_count       INTEGER,
  cards_avg           NUMERIC,
  booking_points_avg  NUMERIC,
  updated_at          TIMESTAMPTZ DEFAULT now()
);

-- Referee per match (from the fixture payload) — drives the referee adjustment.
ALTER TABLE matches ADD COLUMN IF NOT EXISTS referee TEXT;

-- Row Level Security: both tables are read-only reference data for the
-- match-detail panels. SELECT for anon + authenticated; writes restricted to
-- the service role (the engine), which bypasses RLS. (Re-affirmed idempotently
-- in migration 031.)
ALTER TABLE team_statistics ENABLE ROW LEVEL SECURITY;
ALTER TABLE referee_stats   ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS anon_read ON team_statistics;
CREATE POLICY anon_read ON team_statistics
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS anon_read ON referee_stats;
CREATE POLICY anon_read ON referee_stats
  FOR SELECT TO anon, authenticated USING (true);
