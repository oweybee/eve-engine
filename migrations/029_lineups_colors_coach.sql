-- Migration 029: store kit colours + manager on lineups.
--
-- API-Football's /fixtures/lineups payload carries each team's kit colours and
-- coach, but we weren't persisting them. The match-detail pitch view uses the
-- colours for the shirts and shows the manager in the compact list.

ALTER TABLE lineups ADD COLUMN IF NOT EXISTS team_colors JSONB;
ALTER TABLE lineups ADD COLUMN IF NOT EXISTS coach       TEXT;
