-- 131 — a league has a per-side scoring rate too
--
-- APPLIED 8 Oct 2026.
--
-- 129 gave the hit-rate card a base rate for match totals and match results.
-- Four markets on the board are about ONE CLUB and not about the match, and
-- those had no measured base at all: Scored 1+, Scored 2+, Failed to score and
-- Clean Sheets. The card drew a run with nothing beside it, which is honest
-- and nearly useless, and "league not measured" on four of fourteen sliders.
--
-- ── BOTH NEW COLUMNS ARE PER SIDE, ACROSS BOTH GROUNDS ──────────────────
--
-- Which is the question a team-scoped reading asks: `lib/hitRate` counts a
-- club's own last five across home and away, so the base it is set beside has
-- to be the rate for a side irrespective of ground. Each settled match
-- contributes two observations, which is what the (home + away) / 2 is.
--
-- ── AND A CLEAN SHEET IS EXACTLY ONE MINUS SCORING ──────────────────────
--
-- Not an approximation of it. One side keeping a clean sheet IS the other side
-- failing to score, so the two markets are the same count read from opposite
-- ends and neither needs a column of its own. Same for Failed to score.
--
-- Verified after applying: 44 competitions, 94,386 settled matches, and all 38
-- competitions with fixtures inside a fortnight are covered.

create or replace view public.v_league_hit_rates as
select
  l.id                                                           as league_id,
  l.name                                                         as league,
  l.country                                                      as country,
  count(*)::int                                                  as games,
  round(avg(((m.goals_home + m.goals_away) > 1.5)::int::numeric), 4) as over15_rate,
  round(avg(((m.goals_home + m.goals_away) > 2.5)::int::numeric), 4) as over25_rate,
  round(avg(((m.goals_home + m.goals_away) > 3.5)::int::numeric), 4) as over35_rate,
  round(avg(((m.goals_home + m.goals_away) < 2.5)::int::numeric), 4) as under25_rate,
  round(avg((m.goals_home > 0 and m.goals_away > 0)::int::numeric), 4) as btts_rate,
  round(avg((m.goals_home > m.goals_away)::int::numeric), 4)      as home_win_rate,
  round(avg((m.goals_home = m.goals_away)::int::numeric), 4)      as draw_rate,
  round(avg((m.goals_away > m.goals_home)::int::numeric), 4)      as away_win_rate,
  max(m.kickoff_at)                                              as last_match,
  -- NEW IN 131. Appended rather than inserted, because `create or replace
  -- view` may add columns at the end and may not reorder the ones already
  -- there; a reordering would be a drop and a recreate, and every grant and
  -- dependency with it.
  round((avg((m.goals_home > 0)::int::numeric)
       + avg((m.goals_away > 0)::int::numeric)) / 2, 4)           as scored_rate,
  round((avg((m.goals_home > 1.5)::int::numeric)
       + avg((m.goals_away > 1.5)::int::numeric)) / 2, 4)         as scored2_rate
from matches m
join leagues l on l.id = m.league_id
where m.goals_home is not null
  and m.goals_away is not null
group by l.id, l.name, l.country
having count(*) >= 50;

comment on view public.v_league_hit_rates is
  'Per-competition base RATES counted from settled matches. Feeds the hit-rate '
  'board''s league comparison. Rates, never means: the board is a count and a '
  'mean would have to be turned into one by assuming a distribution. '
  'scored_rate and scored2_rate are PER SIDE across both grounds, which is the '
  'question a team-scoped reading asks; a clean sheet is exactly 1 - '
  'scored_rate, because one side keeping one is the other failing to score.';

grant select on public.v_league_hit_rates to anon, authenticated;
