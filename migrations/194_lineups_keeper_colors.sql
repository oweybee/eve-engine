-- 194: keep the goalkeeper kit.
--
-- API-Football's lineups carry team.colors.player AND team.colors.goalkeeper
-- ({primary, number, border}). lib/lineupCapture.js and fetchMatchDetails.js
-- stored only the player kit in team_colors, so a pitch view could not draw a
-- keeper in his own shirt. team_colors keeps its shape (lib/matchIntel.ts on the
-- site reads it as the outfield kit); the keeper kit gets its own column.
-- APPLY BEFORE deploying the writer change that fills it, or upserts fail on
-- an unknown column.
alter table public.lineups add column if not exists keeper_colors jsonb;
comment on column public.lineups.keeper_colors is
  'Goalkeeper kit from API-Football lineups team.colors.goalkeeper: {primary, number, border} hex without #. Null when the vendor sends none.';
