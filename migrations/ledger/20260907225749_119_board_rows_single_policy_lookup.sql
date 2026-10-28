-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260907225749, name 119_board_rows_single_policy_lookup. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.


-- 119: v_board_rows did two correlated policy lookups per row (one for
-- price_state, one for is_publishable), so 54 rows cost 108 index scans.
-- Fold them into one lateral join.
drop view if exists public.v_board_rows;

create view public.v_board_rows
with (security_invoker = true) as
select
  b.computed_id, b.match_id, b.kickoff_at, b.match_status,
  b.home_team_name, b.away_team_name, b.league,
  b.best_outcome, b.max_edge, b.signal_tier, b.mes,
  b.model_architecture, b.confidence_tier,
  b.odds_fetched_at, b.computed_at,
  now() - b.odds_fetched_at as price_age,
  round(extract(epoch from (now() - b.odds_fetched_at))/60.0)::int as price_age_minutes,
  round(b.hrs_to_ko, 2) as hours_to_kickoff,
  pol.tier as freshness_tier,
  pol.max_price_age as price_budget,
  pol.refresh_every,
  case
    when not pol.publish                     then 'not_published'
    when b.odds_fetched_at is null           then 'unknown'
    when now() - b.odds_fetched_at <= pol.max_price_age then 'fresh'
    else 'stale'
  end as price_state,
  (pol.publish
   and b.odds_fetched_at is not null
   and now() - b.odds_fetched_at <= pol.max_price_age) as is_publishable,
  b.all_home_odds, b.all_draw_odds, b.all_away_odds,
  b.best_home_odds, b.best_draw_odds, b.best_away_odds,
  b.best_home_book, b.best_draw_book, b.best_away_book,
  b.home_edge, b.draw_edge, b.away_edge, b.consensus
from (
  select distinct on (cv.match_id)
    cv.id as computed_id, cv.match_id, m.kickoff_at, m.status as match_status,
    ht.name as home_team_name, at2.name as away_team_name, l.name as league,
    cv.best_outcome, cv.max_edge, cv.signal_tier, cv.max_edge_score as mes,
    cv.model_architecture, cv.confidence_tier,
    cv.odds_fetched_at, cv.computed_at,
    extract(epoch from (m.kickoff_at - now()))/3600.0 as hrs_to_ko,
    cv.all_home_odds, cv.all_draw_odds, cv.all_away_odds,
    cv.best_home_odds, cv.best_draw_odds, cv.best_away_odds,
    cv.best_home_book, cv.best_draw_book, cv.best_away_book,
    cv.home_edge, cv.draw_edge, cv.away_edge, cv.consensus
  from public.computed_values cv
  join public.matches m on m.id = cv.match_id
  left join public.teams ht on ht.id = m.home_team_id
  left join public.teams at2 on at2.id = m.away_team_id
  left join public.leagues l on l.id = m.league_id
  where m.kickoff_at > now()
  order by cv.match_id, cv.computed_at desc
) b
join lateral (
  select tier, max_price_age, refresh_every, publish
  from public.price_freshness_policy
  where b.hrs_to_ko < max_hours_to_ko
  order by max_hours_to_ko asc limit 1
) pol on true;

comment on view public.v_board_rows is
  'The board read, gated on price age. One row per upcoming match. Filter on is_publishable for anywhere a wrong price costs money (free pick, headline slots). Elsewhere prefer price_state: show fresh rows normally, show stale rows with the real age printed from odds_fetched_at, and drop not_published entirely. Never render a price without its age.';

