-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260620190849, name create_promotable_signals_views. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.


-- View 1: All promotable signals.
-- Requires the signal to have been seen in >= 2 detection cycles AND not be volatile.
-- Your app queries this instead of value_signals directly.
CREATE OR REPLACE VIEW promotable_value_signals AS
SELECT
  vs.*,
  t1.name          AS home_team,
  t2.name          AS away_team,
  m.kickoff_at     AS match_kickoff,
  m.status         AS match_status,
  l.name           AS league
FROM value_signals vs
JOIN matches m  ON m.id  = vs.match_id
JOIN teams   t1 ON t1.id = m.home_team_id
JOIN teams   t2 ON t2.id = m.away_team_id
LEFT JOIN leagues l ON l.id = m.league_id
WHERE vs.result       = 'pending'          -- only open signals
  AND vs.detection_count >= 2              -- survived at least 2 cycles (not a glitch)
  AND (vs.is_volatile IS NULL OR vs.is_volatile = false)  -- market not moving against us >15%
  AND m.status        = 'scheduled'        -- match hasn't started
  AND m.kickoff_at    > now()              -- future only
  AND vs.detected_at  < vs.kickoff_at;    -- signal predates kickoff (sanity guard)

-- View 2: Bet-of-the-day candidates — stricter quality bar.
-- Odds cap at 4.0 cuts out the volatile high-variance underdogs.
-- detection_count >= 3 means the signal survived three separate refresh cycles.
CREATE OR REPLACE VIEW bet_of_day_candidates AS
SELECT *
FROM promotable_value_signals
WHERE detection_count  >= 3
  AND detected_odds    <= 4.0              -- no long-shot underdogs
  AND detected_edge    >= 0.05             -- minimum 5% edge
  AND detected_mes     >= 55               -- minimum MES quality threshold
ORDER BY detected_edge DESC;

