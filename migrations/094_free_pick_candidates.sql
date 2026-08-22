-- 094_free_pick_candidates.sql
--
-- "TODAY'S PICK IS FREE" WAS NOT TRUE FOR ANYONE SIGNED OUT.
--
-- The homepage chooses the free pick by scoring the board and taking the best
-- BACKED row. It scores whatever `computed_values` returns — and migration 047
-- caps that table for an anonymous reader. Measured 22 Aug 2026: a full seat
-- sees 216 upcoming priced rows, `preview_computed_value_ids()` returns 5.
-- So a visitor arriving from a Telegram link was shown the best of a 2.3%
-- sample, and the actual pick of the day was invisible to them. Two browsers,
-- two different fixtures, one promise on the pricing page: "Today's pick is
-- free. Every pick is Plus."
--
-- WHY THIS RETURNS ROWS AND NOT A PICK. The obvious shape is a function that
-- ranks by MES and returns one winner. It cannot be written honestly here,
-- and the reason is worth recording: `computed_values.fair_*_odds` is the
-- MODEL side, not the market's fair line. Checked against the live row for
-- Eastleigh v Scunthorpe — `fair_away_odds` 2.0166 is 49.59%, which is exactly
-- what the browser shows as MODEL, while the FAIR figure it draws (46.6%)
-- comes from Shin-de-vigging the three best prices IN THE BROWSER. There is no
-- stored market-fair column. So ranking by score in SQL would require a third
-- copy of the de-vig — SQL, engine, browser — with nothing keeping them equal,
-- which is what the `MODEL_SIGMA` hand-copy cost twice in production without
-- either copy throwing, and what migration 083 refused for the same reason.
--
-- So SQL picks CANDIDATES and the browser picks the PICK. The candidate test
-- is the eligibility box — odds in [1.40, 3.00) and edge in [3%, 10%) — which
-- is pure arithmetic on stored columns with no model in it, and every backed
-- row is a subset of it by construction. The browser then scores those rows
-- with its own scorer, so the card and the board cannot disagree.
--
-- HOW MUCH IT EXPOSES, MEASURED BEFORE IT WAS WRITTEN. Of 213 upcoming priced
-- fixtures, 8 carry an eligible leg — 3.8%. It is bounded twice: by the box,
-- and by `p_limit` matches. It exposes no `value_signals`, no `odds`, no
-- `odds_snapshots` and no `elo_forecasts`; migration 047 governs all four and
-- is untouched.
--
-- THE COLUMN LIST IS EXPLICIT, not `to_jsonb(cv)`. A row-to-json would export
-- whatever column someone adds to `computed_values` next, which is fail-OPEN
-- on a function that exists to cross a paywall. These are exactly the columns
-- `FEED_SELECT` in eve-frontend/lib/feed.js already reads, in the same shape,
-- so the browser normalises the result through the same path as the board.

create or replace function public.free_pick_candidates(p_limit integer default 40)
returns setof jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  with eligible as (
    select cv.match_id, max(leg.edge) as top_eligible_edge
    from computed_values cv
    join matches m on m.id = cv.match_id
    cross join lateral (values
      (cv.best_home_odds::numeric,  cv.home_edge::numeric),
      (cv.best_draw_odds::numeric,  cv.draw_edge::numeric),
      (cv.best_away_odds::numeric,  cv.away_edge::numeric),
      (cv.over_odds::numeric,       cv.over_edge::numeric),
      (cv.under_odds::numeric,      cv.under_edge::numeric),
      (cv.btts_yes_odds::numeric,   cv.btts_yes_edge::numeric),
      (cv.btts_no_odds::numeric,    cv.btts_no_edge::numeric)
    ) as leg(odds, edge)
    where m.kickoff_at > now()
      and leg.odds is not null and leg.edge is not null
      and leg.odds >= 1.40 and leg.odds < 3.00
      and leg.edge >= 0.03 and leg.edge < 0.10
    group by cv.match_id
    order by max(leg.edge) desc
    limit greatest(1, least(coalesce(p_limit, 40), 60))
  )
  select jsonb_build_object(
      'match_id', cv.match_id,
      'model_architecture', cv.model_architecture,
      'best_home_odds', cv.best_home_odds,
      'best_draw_odds', cv.best_draw_odds,
      'best_away_odds', cv.best_away_odds,
      'best_home_book', cv.best_home_book,
      'best_draw_book', cv.best_draw_book,
      'best_away_book', cv.best_away_book,
      'all_home_odds', cv.all_home_odds,
      'all_draw_odds', cv.all_draw_odds,
      'all_away_odds', cv.all_away_odds,
      'fair_home_odds', cv.fair_home_odds,
      'fair_draw_odds', cv.fair_draw_odds,
      'fair_away_odds', cv.fair_away_odds,
      'home_edge', cv.home_edge,
      'draw_edge', cv.draw_edge,
      'away_edge', cv.away_edge,
      'home_value', cv.home_value,
      'draw_value', cv.draw_value,
      'away_value', cv.away_value,
      'max_edge', cv.max_edge,
      'computed_at', cv.computed_at,
      'odds_fetched_at', cv.odds_fetched_at,
      'over_odds', cv.over_odds,
      'under_odds', cv.under_odds,
      'over_book', cv.over_book,
      'under_book', cv.under_book,
      'over_edge', cv.over_edge,
      'under_edge', cv.under_edge,
      'over_value', cv.over_value,
      'under_value', cv.under_value,
      'totals_line', cv.totals_line,
      'btts_yes_odds', cv.btts_yes_odds,
      'btts_no_odds', cv.btts_no_odds,
      'btts_yes_book', cv.btts_yes_book,
      'btts_no_book', cv.btts_no_book,
      'btts_yes_edge', cv.btts_yes_edge,
      'btts_no_edge', cv.btts_no_edge,
      'btts_yes_value', cv.btts_yes_value,
      'btts_no_value', cv.btts_no_value,
      'btts_model_prob', cv.btts_model_prob,
      'all_btts_yes_odds', cv.all_btts_yes_odds,
      'all_btts_no_odds', cv.all_btts_no_odds,
      'bookings_over_odds', cv.bookings_over_odds,
      'bookings_under_odds', cv.bookings_under_odds,
      'bookings_line', cv.bookings_line,
      'bookings_over_edge', cv.bookings_over_edge,
      'bookings_under_edge', cv.bookings_under_edge,
      'bookings_over_value', cv.bookings_over_value,
      'bookings_under_value', cv.bookings_under_value,
      'bookings_model_prob', cv.bookings_model_prob,
      'bookings_lambda', cv.bookings_lambda,
      'corners_over_odds', cv.corners_over_odds,
      'corners_under_odds', cv.corners_under_odds,
      'corners_line', cv.corners_line,
      'corners_over_edge', cv.corners_over_edge,
      'corners_under_edge', cv.corners_under_edge,
      'corners_over_value', cv.corners_over_value,
      'corners_under_value', cv.corners_under_value,
      'corners_model_prob', cv.corners_model_prob,
      'corners_lambda', cv.corners_lambda,
      'confidence_score', cv.confidence_score,
      'max_edge_score', cv.max_edge_score,
      'best_outcome', cv.best_outcome,
      'ensemble_home_prob', cv.ensemble_home_prob,
      'ensemble_draw_prob', cv.ensemble_draw_prob,
      'ensemble_away_prob', cv.ensemble_away_prob,
      'ensemble_over_prob', cv.ensemble_over_prob,
      'ensemble_btts_prob', cv.ensemble_btts_prob,
      'ev_per_unit', cv.ev_per_unit,
      'consensus', cv.consensus,
      'explain', cv.explain,
      'home_value_score', cv.home_value_score,
      'draw_value_score', cv.draw_value_score,
      'away_value_score', cv.away_value_score,
      'home_ruby', cv.home_ruby,
      'draw_ruby', cv.draw_ruby,
      'away_ruby', cv.away_ruby,
      'match', jsonb_build_object(
        'kickoff_at', m.kickoff_at,
        'status',     m.status,
        'home_team',  jsonb_build_object('id', th.id, 'name', th.name,
                                         'short_name', th.short_name, 'crest_url', th.crest_url),
        'away_team',  jsonb_build_object('id', ta.id, 'name', ta.name,
                                         'short_name', ta.short_name, 'crest_url', ta.crest_url),
        'league',     jsonb_build_object('name', lg.name, 'country', lg.country)
      )
    )
  from computed_values cv
  join eligible e on e.match_id = cv.match_id
  join matches m  on m.id = cv.match_id
  left join teams th on th.id = m.home_team_id
  left join teams ta on ta.id = m.away_team_id
  left join leagues lg on lg.id = m.league_id
  order by e.top_eligible_edge desc, cv.match_id;
$fn$;

comment on function public.free_pick_candidates(integer) is
  'Upcoming computed_values rows whose selection is inside the eligibility box, '
  'for the free pick. SECURITY DEFINER so the one pick the product gives away '
  'is the same fixture for every reader. Ranking is the browser''s: there is no '
  'stored market-fair line, so a SQL score would be a third copy of the de-vig.';

revoke all on function public.free_pick_candidates(integer) from public;
grant execute on function public.free_pick_candidates(integer) to anon, authenticated;

-- ── Assertions ────────────────────────────────────────────────────────────
do $$
declare
  n_rows      integer;
  n_matches   integer;
  n_anon_cv   integer;
  bad         integer;
begin
  select count(*), count(distinct (r->>'match_id'))
    into n_rows, n_matches
    from free_pick_candidates() r;

  -- Every row returned must actually carry an eligible leg. Without this the
  -- function could quietly widen to "any upcoming priced row", which is the
  -- board. Re-derived from the RETURNED jsonb rather than from the query above,
  -- so it tests the output and not the intention.
  select count(*) into bad
    from free_pick_candidates() r
   where not exists (
     select 1 from (values
       ((r->>'best_home_odds')::numeric, (r->>'home_edge')::numeric),
       ((r->>'best_draw_odds')::numeric, (r->>'draw_edge')::numeric),
       ((r->>'best_away_odds')::numeric, (r->>'away_edge')::numeric),
       ((r->>'over_odds')::numeric,      (r->>'over_edge')::numeric),
       ((r->>'under_odds')::numeric,     (r->>'under_edge')::numeric),
       ((r->>'btts_yes_odds')::numeric,  (r->>'btts_yes_edge')::numeric),
       ((r->>'btts_no_odds')::numeric,   (r->>'btts_no_edge')::numeric)
     ) as leg(odds, edge)
      where leg.odds >= 1.40 and leg.odds < 3.00
        and leg.edge >= 0.03 and leg.edge < 0.10
   );
  if bad > 0 then
    raise exception '094: % returned rows carry no eligible leg', bad;
  end if;

  if n_matches > 60 then
    raise exception '094: cap did not hold — % matches returned', n_matches;
  end if;

  -- THE PAYWALL IS UNMOVED. anon must still see only its preview of the table
  -- itself; the function is the only thing that crosses it.
  set local role anon;
  select count(*) into n_anon_cv from computed_values;
  reset role;
  if n_anon_cv > 60 then
    raise exception '094: anon now reads % computed_values rows — 047 has moved', n_anon_cv;
  end if;

  raise notice '094 ok — % rows over % matches; anon computed_values still %',
    n_rows, n_matches, n_anon_cv;
end $$;

