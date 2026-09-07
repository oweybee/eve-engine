-- 124_the_free_pick_is_the_days_best_score_not_the_days_best_box.sql
--
-- THE HOMEPAGE SAID "No pick today." OVER FIFTY PRICED FIXTURES CARRYING REAL
-- SCORES, and this function is why.
--
-- 094 built the candidate pool out of the ELIGIBILITY BOX — a row reached it
-- only if some leg was priced 1.40-3.00 at an edge of 3-10%. That was right
-- for the question 094 asked ("find the day's BACKED pick, for every reader,
-- across the paywall"), because a backed row is an in-box row by construction
-- and the box therefore contained every answer.
--
-- THE OWNER CHANGED THE QUESTION (7 Sep 2026): the card shows the day's
-- HIGHEST-SCORING fixture whether or not both ladders back it. The box no
-- longer contains every answer — it contains a small and often EMPTY subset of
-- them. Measured against production the morning this was written, over the 47
-- fresh upcoming priced matches inside the horizon:
--
--     legs with a price and an edge          325
--     legs priced inside 1.40-3.00           232
--     legs with an edge inside 3%-10%          0     <- the box
--     legs with ANY positive edge              2     (max edge 1.94%)
--
-- So `free_pick_candidates(60)` returned ZERO ROWS, the browser`s `??` does not
-- fall through on an empty array, and the loudest surface on the site published
-- an emptiness as a finding about the market. Not a quiet day: the board was
-- full and its rows were scoring 41, 31, 26, 26 and 25.
--
-- WHAT THIS WIDENS TO, AND WHERE IT STOPS. Every row that can be SCORED at all
-- — a leg with a price and an edge — inside the same three bounds 123 set. The
-- bounds are UNTOUCHED and are the whole reason this widening is safe: still
-- `scheduled`, still inside 14 days, still on a price quoted within 48 hours.
-- A postponed match is still a dead price that looks alive, and 123`s
-- assertions are all re-run below against the wider pool.
--
-- THE ORDER IS KICKOFF, ASCENDING, AND THAT IS A FACT RATHER THAN A PROXY.
-- 094 ordered by the best eligible edge, which was meaningful when every
-- returned row was in the box. It is not a proxy for the SCORE — at 2.35 a
-- 4.1% edge is a 2.7pp gap and scores 61, at 1.42 the SAME edge is a 4.5pp gap
-- and scores 79 — and there is no honest SQL ordering by score, because
-- `computed_values` stores no de-vigged market probability and a Shin de-vig in
-- Postgres would be the third copy of a model with nothing keeping them equal.
-- So when the cap bites it drops the FURTHEST-OUT fixtures, which is what the
-- board`s own `.limit(80)` already does and is a statement a reader can check.
--
-- THE CAP IS 80 MATCHES, up from 60, and today it does not bite: 47 fresh rows
-- inside the horizon, one architecture apiece. Each row is ~3.1 kB of jsonb, so
-- 80 is ~250 kB — the same order as the board`s own read for a Plus member, on
-- a page that already issues it.
--
-- NOTHING THAT WAS GATED IS UNGATED. 047 is untouched; anon`s own
-- `computed_values` read is asserted unmoved below. What crosses the line is
-- still only what the product was always going to give away: ONE fixture a day,
-- named on the homepage. The BOARD is unchanged and still capped — it feeds the
-- KPI strip and every count, and those are a census of what THIS reader may see.
--
-- APPLIED AND VERIFIED IN PRODUCTION, 7 Sep 2026, from the anon seat — which
-- is the seat a signed-out homepage actually uses. Candidates 0 -> 47 across
-- 47 matches, every one kicking off inside 29 hours, while anon's own
-- `computed_values` read is unmoved at its 047 preview (12 rows). Rehearsed
-- first as the whole file with `commit` replaced by `rollback`: the assertions
-- passed and the old function was still in place afterwards.
--
-- Reverting is `migrations/123_...sql` re-applied verbatim.

begin;

create or replace function public.free_pick_candidates(p_limit integer default 40)
returns setof jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  with pool as (
    -- A LEG WITH A PRICE AND AN EDGE IS THE WHOLE FILTER NOW. `scoreOf` fails
    -- closed without both, so a row carrying neither could never be the day`s
    -- highest score and is not a candidate. That is the only thing left of the
    -- box: the RANGES are gone, the requirement that the row be scoreable is not.
    select cv.match_id, min(m.kickoff_at) as kickoff_at
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
    where m.status = 'scheduled'
      and m.kickoff_at > now()
      and m.kickoff_at <= now() + interval '14 days'
      and cv.odds_fetched_at > now() - interval '48 hours'
      and leg.odds is not null and leg.edge is not null
      and leg.odds > 1
    group by cv.match_id
    order by min(m.kickoff_at) asc
    limit greatest(1, least(coalesce(p_limit, 40), 80))
  )
  , picked as (
    select
      cv.match_id, cv.model_architecture, cv.best_home_odds, cv.best_draw_odds,
      cv.best_away_odds, cv.best_home_book, cv.best_draw_book, cv.best_away_book,
      cv.all_home_odds, cv.all_draw_odds, cv.all_away_odds, cv.fair_home_odds,
      cv.fair_draw_odds, cv.fair_away_odds, cv.home_edge, cv.draw_edge, cv.away_edge,
      cv.home_value, cv.draw_value, cv.away_value, cv.max_edge, cv.computed_at,
      cv.odds_fetched_at, cv.over_odds, cv.under_odds, cv.over_book, cv.under_book,
      cv.over_edge, cv.under_edge, cv.over_value, cv.under_value, cv.totals_line,
      cv.btts_yes_odds, cv.btts_no_odds, cv.btts_yes_book, cv.btts_no_book,
      cv.btts_yes_edge, cv.btts_no_edge, cv.btts_yes_value, cv.btts_no_value,
      cv.btts_model_prob, cv.all_btts_yes_odds, cv.all_btts_no_odds,
      cv.bookings_over_odds, cv.bookings_under_odds, cv.bookings_line,
      cv.bookings_over_edge, cv.bookings_under_edge, cv.bookings_over_value,
      cv.bookings_under_value, cv.bookings_model_prob, cv.bookings_lambda,
      cv.corners_over_odds, cv.corners_under_odds, cv.corners_line,
      cv.corners_over_edge, cv.corners_under_edge, cv.corners_over_value,
      cv.corners_under_value, cv.corners_model_prob, cv.corners_lambda,
      cv.confidence_score, cv.max_edge_score, cv.best_outcome, cv.ensemble_home_prob,
      cv.ensemble_draw_prob, cv.ensemble_away_prob, cv.ensemble_over_prob,
      cv.ensemble_btts_prob, cv.ev_per_unit, cv.consensus, cv.explain,
      cv.home_value_score, cv.draw_value_score, cv.away_value_score, cv.home_ruby,
      cv.draw_ruby, cv.away_ruby,
      e.kickoff_at as pool_kickoff,
      jsonb_build_object(
        'kickoff_at', m.kickoff_at,
        'status',     m.status,
        'home_team',  jsonb_build_object('id', th.id, 'name', th.name,
                                         'short_name', th.short_name, 'crest_url', th.crest_url),
        'away_team',  jsonb_build_object('id', ta.id, 'name', ta.name,
                                         'short_name', ta.short_name, 'crest_url', ta.crest_url),
        'league',     jsonb_build_object('name', lg.name, 'country', lg.country)
      ) as match
    from computed_values cv
    join pool e on e.match_id = cv.match_id
    join matches m  on m.id = cv.match_id
    left join teams th on th.id = m.home_team_id
    left join teams ta on ta.id = m.away_team_id
    left join leagues lg on lg.id = m.league_id
    -- THE SIBLING-ROW GUARD, unchanged from 123 and not redundant with the CTE.
    -- `pool` selects MATCH IDS; this join then returns EVERY `computed_values`
    -- row for that match, one per architecture. Wisla Plock carried two —
    -- API_PREDICTIVE at 458 hours and MARKET_ANCHORED at 513. Without this a
    -- match qualifying on a fresh row drags its stale sibling out with it, and
    -- `mergeMatchRows` in the browser may take a field from either.
    where cv.odds_fetched_at > now() - interval '48 hours'
  )
  select to_jsonb(p) - 'pool_kickoff'
  from picked p
  order by p.pool_kickoff asc, p.match_id;
$fn$;

comment on function public.free_pick_candidates(integer) is
  'Upcoming, scoreable computed_values rows for the homepage free pick — every '
  'row with a priced leg carrying an edge, not only the eligibility box, '
  'because the card now shows the day''s HIGHEST SCORE whether or not both '
  'ladders back it. Bounded to a scheduled fixture inside 14 days on a price '
  'quoted within 48 hours: a postponed match is a dead price that looks alive, '
  'and kickoff_at > now() alone re-admits it. Those bounds are BACKSTOPS — '
  'eve-frontend/lib/pickWindow holds the product rule at 7 days and 24 hours. '
  'Ordered by kickoff so a bitten cap drops the furthest-out fixture. '
  'SECURITY DEFINER so the one pick the product gives away is the same fixture '
  'for every reader. Ranking is the browser''s: there is no stored market-fair '
  'line, so a SQL score would be a third copy of the de-vig.';

revoke all on function public.free_pick_candidates(integer) from public;
grant execute on function public.free_pick_candidates(integer) to anon, authenticated;

-- ── Assertions ─────────────────────────────────────────────────────
do $$
declare
  n_rows     integer;
  n_matches  integer;
  n_keys     integer;
  n_anon_cv  integer;
  bad        integer;
  reported   integer;
begin
  select count(*), count(distinct (r->>'match_id'))
    into n_rows, n_matches
    from free_pick_candidates(80) r;

  -- 123's assertions, re-run against the WIDER pool. Widening the box must not
  -- widen the window, and this is what says it did not.
  select count(*) into reported
    from free_pick_candidates(80) r
   where r->>'match_id' = '76863a0f-140d-442b-8b2e-a7d0b0101d4d';
  if reported > 0 then
    raise exception '124: Wisla Plock v Lech Poznan is a free-pick candidate again';
  end if;

  select count(*) into bad
    from free_pick_candidates(80) r
   where (r->'match'->>'status') is distinct from 'scheduled'
      or (r->'match'->>'kickoff_at')::timestamptz <= now()
      or (r->'match'->>'kickoff_at')::timestamptz >  now() + interval '14 days'
      or (r->>'odds_fetched_at') is null
      or (r->>'odds_fetched_at')::timestamptz <= now() - interval '48 hours';
  if bad > 0 then
    raise exception '124: % returned rows are outside the window', bad;
  end if;

  -- EVERY ROW IS SCOREABLE. This is what replaces 094's eligible-leg assertion:
  -- a row with no priced leg carrying an edge cannot be scored, so it cannot be
  -- the day's highest score and has no business in the pool. Re-derived from
  -- the RETURNED jsonb, so it tests the output and not the intention.
  select count(*) into bad
    from free_pick_candidates(80) r
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
      where leg.odds is not null and leg.edge is not null and leg.odds > 1
   );
  if bad > 0 then
    raise exception '124: % returned rows carry no scoreable leg', bad;
  end if;

  if n_matches > 80 then
    raise exception '124: cap did not hold — % matches returned', n_matches;
  end if;

  -- THE WIDENING ACTUALLY HAPPENED. The whole point is that the box was empty
  -- on the day this shipped, so a function still returning zero rows over a
  -- board full of priced fixtures has not been replaced at all.
  if n_rows = 0 and exists (
    select 1 from computed_values cv join matches m on m.id = cv.match_id
     where m.status = 'scheduled' and m.kickoff_at > now()
       and m.kickoff_at <= now() + interval '14 days'
       and cv.odds_fetched_at > now() - interval '48 hours'
  ) then
    raise exception '124: still returning nothing over a live priced board';
  end if;

  -- THE PAYLOAD SHAPE IS UNCHANGED. The select list is lifted from 123
  -- verbatim; a field lost here reaches the browser as an absent price rather
  -- than as an error.
  if n_rows > 0 then
    select count(*) into n_keys
      from (select jsonb_object_keys(r) from free_pick_candidates(1) r limit 200) s;
    if n_keys <> 79 then
      raise exception '124: payload is % keys, expected 79', n_keys;
    end if;
  end if;

  -- THE PAYWALL IS UNMOVED. anon must still see only its preview of the table
  -- itself; the function is the only thing that crosses it.
  set local role anon;
  select count(*) into n_anon_cv from computed_values;
  reset role;
  if n_anon_cv > 60 then
    raise exception '124: anon now reads % computed_values rows — 047 has moved', n_anon_cv;
  end if;

  raise notice '124 ok — % rows over % matches; anon computed_values still %',
    n_rows, n_matches, n_anon_cv;
end $$;

commit;
