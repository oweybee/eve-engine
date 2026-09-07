-- 123_a_postponed_fixture_is_a_dead_price_that_looks_alive.sql
--
-- A POSTPONED MATCH RAN AS THE HOMEPAGE'S ◆ PRIME FREE PICK FOR THREE WEEKS.
--
-- Wisla Plock v Lech Poznan (Ekstraklasa) was due on 16 August 2026. Ten
-- bookmakers were pricing it, `computeValues` cleared its data-quality gate on
-- a price minutes old, and two `computed_values` rows were written. Then the
-- match was called off: API-Football moved `kickoff_at` to 17 December, the
-- books pulled the market, and `odds` stops dead at 2026-08-16 21:10. Nothing
-- touched the computed rows. On 4 September this function was still handing
-- them out as free-pick candidates — the away side at 1.95 for a +5.2% edge, a
-- price no bookmaker had quoted in 19 days, on a game 104 days away.
--
-- A RESCHEDULE IS THE ONE EVENT THAT MAKES A DEAD PRICE LOOK LIVE AGAIN. Every
-- other stale row falls off the front of the product by kicking off. Move the
-- kickoff forward and `kickoff_at > now()` — the only test this function had —
-- answers yes again, correctly, about the wrong question.
--
-- THE GATE THAT SHOULD HAVE CAUGHT IT EXISTS AND WAS WRITTEN ON THE WRONG
-- TABLE. `gate_promotable_value_signals_against_stale_fixtures` (3 Sep 2026)
-- added exactly the right five conditions — published model, still scheduled,
-- kickoff ahead, a postponement drift guard, and a 48-hour price age — to
-- `promotable_value_signals`, a view over `value_signals`, under a comment
-- reading "Feeds bet_of_day_candidates / homepage free pick". IT DOES NOT. The
-- homepage free pick is ranked over THIS function, which reads
-- `computed_values`; the view is read by `/admin` and by nothing else. That
-- comment is corrected below.
--
-- WHAT THIS ADDS, AND WHY IT IS TWO BOUNDS AND NOT ONE. Measured against
-- production, 4 Sep 2026, over the 216 upcoming priced rows:
--
--      0.0 -   1.0 days out   134 rows   price age    0.2h -   20.1h
--      1.0 -   1.9 days out    64 rows   price age    1.6h -   11.1h
--      3.7         days out     1 row    price age            317.3h
--      4.8         days out     2 rows   price age  321.9h -  323.3h
--     10.7 - 103.7 days out    15 rows   price age  303.7h - 1199.5h
--
-- A 284-hour chasm with nothing in it, so the threshold itself is not delicate.
-- WHICH bound catches which row is. NEC Nijmegen v Excelsior kicks off in 3.7
-- days on a price 13 days old, so a horizon alone admits it; and a book opening
-- an early market on a December fixture would be fresh, so an age bound alone
-- admits that. Neither is a weaker form of the other.
--
-- THESE ARE BACKSTOPS AND THE BROWSER HOLDS THE PRODUCT RULE. `lib/pickWindow`
-- in eve-frontend refuses anything outside SEVEN days or over TWENTY-FOUR hours
-- old — the hour `priceAgeNote` starts telling a reader the price is not
-- current. The bounds here are deliberately looser than that: a horizon of
-- twice the board's window so widening the board never hits a wall in SQL, and
-- the same 48 hours the sibling view uses so there is one staleness backstop
-- across both gates. If these two numbers ever decide what a reader sees, the
-- browser guard has failed and that is the thing to fix.
--
-- `m.status = 'scheduled'` IS THE THIRD, and it is free: the status census is
-- completed/scheduled and nothing else, and 0 of the 216 upcoming priced rows
-- carry anything but 'scheduled'. An equality test rather than `<> 'completed'`
-- because a free pick is an OFFER and fails closed — and because if the feed
-- ever learns to say 'postponed', this excludes it without another migration.
--
-- NO DRIFT GUARD HERE, AND THAT IS A DATA FACT. The sibling view can compare
-- `value_signals.kickoff_at` against the fixture's current one, which detects a
-- postponement directly. `computed_values` stores NO kickoff snapshot — only
-- `computed_at` and `odds_fetched_at` — so the price age is the proxy, and the
-- chasm above is why it is a good one. Adding such a column is eve-engine's and
-- is not done here.
--
-- THE PROJECTION IS THE DEPLOYED ONE, AND 094 IN THIS REPO CANNOT EVER HAVE
-- RUN. It builds the payload with a single `jsonb_build_object` over 79 keys —
-- 158 arguments — and Postgres refuses at 100: "cannot pass more than 100
-- arguments to a function". So the committed file is not the function that has
-- been serving the homepage; someone rewrote it in the database as a `to_jsonb`
-- over an explicit select list and never brought the file back. That is the
-- exact drift this project's own rule warns about — READ THE TABLE, NOT THE
-- MIGRATION — and it is why the header above could describe gates that were not
-- there. This file is the deployed shape plus the new bounds, so the repo and
-- the database agree again, and the assertion below re-counts the 79 keys so
-- the browser cannot silently lose a field to the rewrite.
--
-- `to_jsonb(p)` over an EXPLICIT select list is not the fail-open shape 094's
-- header argued against: the column list is still written out, so a new
-- `computed_values` column is not exported until someone adds it here.
--
-- REVERSIBLE: re-run the function body from migration 094 without the three
-- WHERE clauses added below. Do not re-run 094 itself — it does not compile.

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
    where m.status = 'scheduled'
      and m.kickoff_at > now()
      and m.kickoff_at <= now() + interval '14 days'
      and cv.odds_fetched_at > now() - interval '48 hours'
      and leg.odds is not null and leg.edge is not null
      and leg.odds >= 1.40 and leg.odds < 3.00
      and leg.edge >= 0.03 and leg.edge < 0.10
    group by cv.match_id
    order by max(leg.edge) desc
    limit greatest(1, least(coalesce(p_limit, 40), 60))
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
      e.top_eligible_edge,
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
    join eligible e on e.match_id = cv.match_id
    join matches m  on m.id = cv.match_id
    left join teams th on th.id = m.home_team_id
    left join teams ta on ta.id = m.away_team_id
    left join leagues lg on lg.id = m.league_id
    -- THE SIBLING-ROW GUARD, and it is not redundant with the CTE. `eligible`
    -- selects MATCH IDS; this join then returns EVERY `computed_values` row for
    -- that match, one per architecture. Wisla Plock carried two — API_PREDICTIVE
    -- at 458 hours and MARKET_ANCHORED at 513. Without this a match that
    -- qualifies on a fresh row drags its stale sibling out with it, and
    -- `mergeMatchRows` in the browser may take a field from either.
    where cv.odds_fetched_at > now() - interval '48 hours'
  )
  select to_jsonb(p) - 'top_eligible_edge'
  from picked p
  order by p.top_eligible_edge desc, p.match_id;
$fn$;

comment on function public.free_pick_candidates(integer) is
  'Upcoming computed_values rows whose selection is inside the eligibility box, '
  'for the free pick. Bounded to a scheduled fixture inside 14 days on a price '
  'quoted within 48 hours: a postponed match is a dead price that looks alive, '
  'and kickoff_at > now() alone re-admits it. Those bounds are BACKSTOPS — '
  'eve-frontend/lib/pickWindow holds the product rule at 7 days and 24 hours. '
  'SECURITY DEFINER so the one pick the product gives away is the same fixture '
  'for every reader. Ranking is the browser''s: there is no stored market-fair '
  'line, so a SQL score would be a third copy of the de-vig.';

-- The sibling view's own comment names a consumer it does not have. Corrected
-- rather than left to mislead the next person the way it misled this one.
comment on view public.promotable_value_signals is
  'Live, publishable value signals. Gated on: model published, match still '
  'scheduled and ahead, signal kickoff matching the fixture (postponement drift '
  'guard), and price detected within 48h. Read by /admin''s engine pulse. It '
  'does NOT feed the homepage free pick — that is free_pick_candidates(), over '
  'computed_values, which carried none of these gates until migration 123.';

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
    from free_pick_candidates() r;

  -- THE REPORTED FIXTURE IS GONE. Named by id rather than by predicate, so this
  -- fails if the bounds are ever loosened back past the row that caused them.
  select count(*) into reported
    from free_pick_candidates() r
   where r->>'match_id' = '76863a0f-140d-442b-8b2e-a7d0b0101d4d';
  if reported > 0 then
    raise exception '123: Wisla Plock v Lech Poznan is still a free-pick candidate';
  end if;

  -- Every returned row is inside the horizon, still scheduled, and on a price
  -- someone quoted this week. Re-derived from the RETURNED jsonb, so it tests
  -- the output and not the intention.
  select count(*) into bad
    from free_pick_candidates() r
   where (r->'match'->>'status') is distinct from 'scheduled'
      or (r->'match'->>'kickoff_at')::timestamptz <= now()
      or (r->'match'->>'kickoff_at')::timestamptz >  now() + interval '14 days'
      or (r->>'odds_fetched_at') is null
      or (r->>'odds_fetched_at')::timestamptz <= now() - interval '48 hours';
  if bad > 0 then
    raise exception '123: % returned rows are outside the window', bad;
  end if;

  -- Unchanged from 094: every row must still carry an eligible leg, or this has
  -- quietly widened to "any upcoming priced row", which is the board.
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
    raise exception '123: % returned rows carry no eligible leg', bad;
  end if;

  if n_matches > 60 then
    raise exception '123: cap did not hold — % matches returned', n_matches;
  end if;

  -- THE PAYLOAD SHAPE IS UNCHANGED BY THE REWRITE. The deployed function was a
  -- to_jsonb() over an explicit select list and this is a jsonb_build_object;
  -- both return 79 keys, and a field lost here would reach the browser as an
  -- absent price rather than as an error.
  if n_rows > 0 then
    select count(*) into n_keys
      from (select jsonb_object_keys(r) from free_pick_candidates(1) r limit 200) s;
    if n_keys <> 79 then
      raise exception '123: payload is % keys, expected 79', n_keys;
    end if;
  end if;

  -- THE PAYWALL IS UNMOVED. anon must still see only its preview of the table
  -- itself; the function is the only thing that crosses it.
  set local role anon;
  select count(*) into n_anon_cv from computed_values;
  reset role;
  if n_anon_cv > 60 then
    raise exception '123: anon now reads % computed_values rows — 047 has moved', n_anon_cv;
  end if;

  raise notice '123 ok — % rows over % matches; anon computed_values still %',
    n_rows, n_matches, n_anon_cv;
end $$;
