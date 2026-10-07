-- 129 · A league base rate is a RATE, not a mean.
--
-- WHAT THIS UNBLOCKS. The hit-rate board states "this fixture's sides have
-- gone over 1.5 in 17 of their last 20" and wants to put the league's own
-- figure beside it, because seventeen of twenty reads as a lot until you know
-- the league does it eight times in ten anyway. Without that comparison the
-- card draws no verdict at all, which is honest and nearly useless.
--
-- WHY THE EXISTING VIEW CANNOT ANSWER IT. `v_league_base_rates` gives MEANS
-- per match — 2.74 goals, 10.2 corners — and a mean cannot be turned into
-- "how often does this happen" without assuming a distribution. Putting a
-- Poisson-derived figure on that card would make a forecast out of a board
-- whose entire claim is that it is a count of what happened. So the rate is
-- counted, the same way the card's own figure is counted.
--
-- IT READS `matches` AND NOTHING ELSE, which is the same source the fixtures
-- come from, so there is no FD-code-to-uuid mapping anywhere in it: the join
-- is `matches.league_id -> leagues.id`. 94,438 settled rows at the time of
-- writing, every one of them carrying both scores.
--
-- THE FLOOR IS 50 MATCHES. `v_league_base_rates` uses 20 for a mean; a RATE
-- needs more before it is worth printing beside a club's twenty, and a
-- competition under the floor simply has no row rather than a shaky one.

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
  max(m.kickoff_at)                                              as last_match
from matches m
join leagues l on l.id = m.league_id
where m.goals_home is not null
  and m.goals_away is not null
group by l.id, l.name, l.country
having count(*) >= 50;

comment on view public.v_league_hit_rates is
  'Per-competition base RATES counted from settled matches. Feeds the hit-rate '
  'board''s league comparison. Rates, never means: the board is a count and a '
  'mean would have to be turned into one by assuming a distribution.';

-- Settled history is not gated anywhere in this product, and this view holds
-- nothing but settled history aggregated to a competition.
grant select on public.v_league_hit_rates to anon, authenticated;
