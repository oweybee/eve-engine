-- 043: per-league season fixture directory, for the frontend's league selector.
--
-- The fixtures board needs "which leagues do we cover this season, and how many
-- games does each hold" WITHOUT pulling every match row to the client to count
-- them. This view aggregates it server-side in one round trip.
--
-- SEASON WINDOW
-- `matches` has no season column — the season is implicit in kickoff dates —
-- and the tracked set mixes autumn–spring leagues (Premier League: Aug–May)
-- with calendar-year leagues (MLS, Allsvenskan, Brasileirão: Feb–Nov). The
-- floor below is 1 Jan of the engine's season-start year (July flip, matching
-- backfillSeasonFixtures.currentSeasonYear): during 2026/27 that is 2026-01-01,
-- which spans BOTH shapes of season in the DB while excluding the historical
-- training corpus (which ends before it).
--
-- security_invoker: the view must run with the caller's rights so the anon
-- public-read policies on matches/leagues (not the view owner's bypass) decide
-- visibility.
CREATE OR REPLACE VIEW league_directory
WITH (security_invoker = true) AS
SELECT
  l.id,
  l.name,
  l.country,
  count(*)                                            AS total,
  count(*) FILTER (WHERE m.kickoff_at > now())        AS upcoming,
  count(*) FILTER (
    WHERE m.status IN ('completed', 'FT', 'AET', 'PEN', 'FINISHED', 'AWD', 'WO')
      AND m.goals_home IS NOT NULL
  )                                                   AS results,
  min(m.kickoff_at)                                   AS first_kickoff,
  max(m.kickoff_at)                                   AS last_kickoff
FROM matches m
JOIN leagues l ON l.id = m.league_id
WHERE m.kickoff_at >= make_date(
  CASE WHEN extract(month FROM now()) >= 7
       THEN extract(year FROM now())::int
       ELSE extract(year FROM now())::int - 1 END,
  1, 1)
GROUP BY l.id, l.name, l.country;

GRANT SELECT ON league_directory TO anon, authenticated;
