-- ── fixture_board() READ EVERY MATCH IN THE TABLE TO FIND THIRTY-NINE ──────
--
-- 11 Oct 2026. The homepage's slowest call, measured in production stats at
-- 868ms typical and 5,985ms at worst, over 7,097 calls.
--
-- WHAT IT WAS DOING. The window bounds sat in a `bounds` CTE and were joined
-- to `matches`. A join condition is not an index condition, so the planner
-- could not seek the kickoff range. Measured on the live board, next-24-hours
-- window:
--
--     ->  Nested Loop  (actual rows=39)
--           Join Filter: ((m.kickoff_at >= b.lo) AND (m.kickoff_at < b.hi))
--           Rows Removed by Join Filter: 102071
--           ->  Index Only Scan using idx_matches_kickoff  (rows=102110)
--                 Heap Fetches: 11169
--
-- It walked all 102,110 rows of `matches` and discarded 102,071 of them to
-- keep 39, on every call, before a single price was looked at: 59ms and 4,050
-- buffer pages of pure waste.
--
-- Inlining the same three expressions into the WHERE and the LIMIT lets the
-- range reach the index:
--
--     Index Cond: ((kickoff_at >= …) AND (kickoff_at < LEAST(…)))
--     Heap Fetches: 0        0.19ms, 3 buffer pages
--
-- NOT ONE OTHER CHARACTER CHANGES. The predicate, the 14-day clamp, the
-- 1..400 cap and every downstream CTE are exactly what they were. This is the
-- same query with the bounds spelled where the planner can see them.
--
-- VERIFIED BEFORE IT WAS APPLIED, because CI could not run (the GitHub Actions
-- allowance was exhausted on 10 Oct). Both versions were run side by side over
-- seven windows — next 24 hours, the London day, 7 days, a 20-day window that
-- exercises the 14-day clamp, the default cap, a cap of 1, and a window with
-- no fixtures in it — and `EXCEPT ALL` came back EMPTY IN BOTH DIRECTIONS on
-- all seven. Same row counts, same jsonb, same order.
--
-- End to end on the next-24-hours window, alternating runs:
--     before   169.6 / 153.1 ms
--     after    114.6 / 111.0 ms
--
-- STILL ON THE TABLE and deliberately not done here: the lateral reads about
-- 2,136 index entries per fixture to keep 58. A loose index scan would make
-- that ~58 seeks. It is a bigger rewrite than this one and wants CI.
--
-- ROLLBACK: the previous definition differs only in its first CTE; restore it
-- from this file's git history.

create or replace function public.fixture_board(
  p_from timestamptz, p_to timestamptz, p_limit integer default 200)
returns setof jsonb
language sql stable security definer
set search_path to 'public','pg_temp'
set work_mem to '32MB'
as $function$
  with fixtures as (
    -- THE BOUNDS ARE INLINED, NOT JOINED FROM A CTE. See the header: as a join
    -- filter this read every row in `matches` on every call.
    select m.id, m.kickoff_at
      from matches m
     where m.kickoff_at >= p_from
       and m.kickoff_at <  least(p_to, p_from + interval '14 days')
     order by m.kickoff_at
     limit greatest(1, least(coalesce(p_limit, 200), 400))
  ),
  freshest as (
    select f.id as match_id, x.market, x.market_line, x.bookmaker,
           x.home_odds, x.draw_odds, x.away_odds, x.fetched_at
      from fixtures f
      cross join lateral (
        select distinct on (o.market, o.market_line, o.bookmaker)
               o.market, o.market_line, o.bookmaker,
               o.home_odds, o.draw_odds, o.away_odds, o.fetched_at
          from odds o
         where o.match_id = f.id
           and o.market in ('h2h', 'totals', 'btts')
           and o.bookmaker <> 'apifootball_live'
           and o.fetched_at <= f.kickoff_at
         order by o.market, o.market_line, o.bookmaker, o.fetched_at desc
      ) x
  ),
  legs as (
    select match_id, market, market_line, bookmaker, fetched_at,
           case market when 'h2h' then 'home' when 'totals' then 'over' else 'btts_yes' end as selection,
           home_odds as odds
      from freshest where home_odds is not null
    union all
    select match_id, market, market_line, bookmaker, fetched_at, 'draw', draw_odds
      from freshest where market = 'h2h' and draw_odds is not null
    union all
    select match_id, market, market_line, bookmaker, fetched_at,
           case market when 'h2h' then 'away' when 'totals' then 'under' else 'btts_no' end as selection,
           away_odds
      from freshest where away_odds is not null
  ),
  best as (
    select distinct on (match_id, market, market_line, selection)
           match_id, market, market_line, selection, odds, bookmaker, fetched_at
      from legs
     where odds > 1
     order by match_id, market, market_line, selection, odds desc, bookmaker
  ),
  priced as (
    select match_id, market, market_line,
           jsonb_object_agg(selection,
             jsonb_build_object('odds', odds, 'book', bookmaker, 'at', fetched_at)) as prices
      from best group by 1, 2, 3
  ),
  depth as (
    select match_id, market, market_line,
           count(distinct bookmaker)::int as books, max(fetched_at) as last_seen
      from freshest group by 1, 2, 3
  )
  select jsonb_build_object(
           'match_id', d.match_id, 'market', d.market, 'market_line', d.market_line,
           'books', d.books, 'last_seen', d.last_seen,
           'prices', coalesce(p.prices, '{}'::jsonb))
    from depth d
    left join priced p
      on p.match_id = d.match_id and p.market = d.market
     and coalesce(p.market_line, -1e9) = coalesce(d.market_line, -1e9)
   order by d.match_id, d.market;
$function$;

-- Scratch function used only to diff old against new before the swap.
drop function if exists public.fixture_board_v2(timestamptz, timestamptz, integer);
