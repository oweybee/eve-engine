-- 031_team_elo.sql
-- =============================================================================
-- Persistent ELO ladder, feeding the in-play half-time supermodel's
-- model-vs-market stage (computeInplayValues.js Stage 2).
--
-- The supermodel was trained on a running ELO (ensemble/train_supermodel_v2.py,
-- K=30 / home-adv=80 / default=1500). Production had no equivalent, which is why
-- Stage 2 was dormant. computeElo.js walks completed `matches` chronologically
-- and upserts the current rating per team here; lib/halftimeFeatures.js reads it.
--
-- ratings are only meaningful once enough real results exist for a team — the
-- feature builder gates on `games` so cold-start teams (and out-of-distribution
-- competitions like the World Cup) leave Stage 2 dormant rather than emitting
-- signals from default 1500s.
-- =============================================================================

-- Keyed by normalised team name (lower, alnum) — the same key halftimeFeatures
-- and fetchStatsLookups use. No team_id column: teams.id is a UUID, ratings are
-- looked up by name, and an unused mistyped FK only invited bugs.
CREATE TABLE IF NOT EXISTS team_elo (
  team_name  TEXT PRIMARY KEY,
  elo        NUMERIC NOT NULL DEFAULT 1500,
  games      INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_team_elo_name ON team_elo (team_name);
