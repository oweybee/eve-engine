-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260907224750, name 111_board_rows_view. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.


-- =====================================================================
-- 111: v_board_rows -- the gated board read.
--
-- Replaces "computed_values joined to matches where kickoff is ahead" with
-- the same thing plus the two columns the board could never answer with:
-- how old the price is, and whether it may be shown at all.
--
-- security_invoker = true so the caller's RLS still applies; this view adds
-- a filter, it must never widen access.
-- =====================================================================

create or replace view public.v_board_rows
with (security_invoker = true) as
select distinct on (cv.match_id)
  cv.id                                   as computed_id,
  cv.match_id,
  m.kickoff_at,
  m.status                                as match_status,
  ht.name                                 as home_team_name,
  at2.name                                as away_team_name,
  l.name                                  as league,

  cv.best_outcome,
  cv.max_edge,
  cv.signal_tier,
  cv.max_edge_score                       as mes,
  cv.model_architecture,
  cv.confidence_tier,

  -- the price and, at last, its age
  cv.odds_fetched_at,
  cv.computed_at,
  now() - cv.odds_fetched_at              as price_age,
  round(extract(epoch from (now() - cv.odds_fetched_at))/60.0)::int as price_age_minutes,

  round(extract(epoch from (m.kickoff_at - now()))/3600.0, 2) as hours_to_kickoff,
  public.price_tier(extract(epoch from (m.kickoff_at - now()))/3600.0) as freshness_tier,
  public.price_max_age(extract(epoch from (m.kickoff_at - now()))/3600.0) as price_budget,

  -- fresh: show the number. stale: show the fixture, withhold the number.
  case
    when (select publish from public.price_freshness_policy
          where tier = public.price_tier(extract(epoch from (m.kickoff_at - now()))/3600.0)) is not true
      then 'not_published'
    when cv.odds_fetched_at is null then 'unknown'
    when now() - cv.odds_fetched_at
         <= public.price_max_age(extract(epoch from (m.kickoff_at - now()))/3600.0)
      then 'fresh'
    else 'stale'
  end as price_state,

  -- the single boolean the board filters on
  (
    (select publish from public.price_freshness_policy
     where tier = public.price_tier(extract(epoch from (m.kickoff_at - now()))/3600.0)) is true
    and cv.odds_fetched_at is not null
    and now() - cv.odds_fetched_at
        <= public.price_max_age(extract(epoch from (m.kickoff_at - now()))/3600.0)
  ) as is_publishable,

  cv.all_home_odds, cv.all_draw_odds, cv.all_away_odds,
  cv.best_home_odds, cv.best_draw_odds, cv.best_away_odds,
  cv.best_home_book, cv.best_draw_book, cv.best_away_book,
  cv.home_edge, cv.draw_edge, cv.away_edge,
  cv.consensus
from public.computed_values cv
join public.matches m  on m.id = cv.match_id
left join public.teams ht  on ht.id = m.home_team_id
left join public.teams at2 on at2.id = m.away_team_id
left join public.leagues l on l.id = m.league_id
where m.kickoff_at > now()
order by cv.match_id, cv.computed_at desc;

comment on view public.v_board_rows is
  'The board read, gated on price age. One row per upcoming match (latest computation). Callers MUST filter on is_publishable; price_state distinguishes a price worth showing from a fixture worth showing with the number withheld. Exposes odds_fetched_at so the UI can print the real age instead of implying freshness with a poll timer.';

