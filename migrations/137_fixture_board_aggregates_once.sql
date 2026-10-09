-- 137 - fixture_board aggregates its prices once, not once per output row
--
-- ── WHAT WAS FOUND ON 9 OCT 2026 ─────────────────────────────────────────────
--
-- The homepage's "Next 24 hours" strip took 6 to 7 seconds to appear. Its read
-- is fixture_board() over a rolling window (3 hours back to 24 ahead), and over
-- that window the function hit the anon statement timeout and failed:
--
--   window          before                       after
--   -3h .. +24h     500, statement timeout 3.5s  473 ms, 1,358 rows
--   +15h .. +21h    500, statement timeout 3.5s  ~0.3 s, 970 rows
--   London day      200 in 1.3 s
--
-- The first 15..21h window is Saturday afternoon: one six-hour slice of the
-- weekend slate is enough to tip it over.
--
-- ── WHY ──────────────────────────────────────────────────────────────────────
--
-- `freshest` (the per-book collapse) costs ~260 ms on the worst window. The
-- other ~2.9 s was the final step: a LEFT JOIN LATERAL that scanned the whole
-- `best` CTE once per `depth` row. A CTE has no index, so that is quadratic in
-- the number of (match, market, line) groups, which is exactly what a busy
-- Saturday multiplies.
--
-- `priced` now aggregates `best` once with GROUP BY and is hash-joined back to
-- `depth`. The join key coalesces market_line so a null line still matches a
-- null line (the old `is not distinct from`) without forcing a nested loop.
-- work_mem is raised for the call because the per-book DISTINCT ON spilled to
-- disk (3.3 MB external merge).
--
-- ── NOTHING ELSE CHANGES ─────────────────────────────────────────────────────
--
-- Same signature, same SECURITY DEFINER, same search_path, same bounds, same
-- filters, same tie-breaks, same output shape. Verified on production before
-- applying: the old and new functions return the identical set over the
-- Saturday window (970 rows, EXCEPT empty in both directions). CREATE OR
-- REPLACE keeps the existing grants.

create or replace function public.fixture_board(
  p_from timestamptz,
  p_to timestamptz,
  p_limit integer default 200
)
returns setof jsonb
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
set work_mem to '32MB'
as $function$
  with bounds as (
    select
      p_from as lo,
      least(p_to, p_from + interval '14 days') as hi,
      greatest(1, least(coalesce(p_limit, 200), 400)) as cap
  ),
  fixtures as (
    select m.id, m.kickoff_at
      from matches m, bounds b
     where m.kickoff_at >= b.lo
       and m.kickoff_at <  b.hi
     order by m.kickoff_at
     limit (select cap from bounds)
  ),
  freshest as (
    select distinct on (o.match_id, o.market, o.market_line, o.bookmaker)
           o.match_id, o.market, o.market_line, o.bookmaker,
           o.home_odds, o.draw_odds, o.away_odds, o.fetched_at
      from odds o
      join fixtures f on f.id = o.match_id
     where o.market in ('h2h', 'totals', 'btts')
       and o.bookmaker <> 'apifootball_live'
       and o.fetched_at <= f.kickoff_at
     order by o.match_id, o.market, o.market_line, o.bookmaker, o.fetched_at desc
  ),
  legs as (
    select match_id, market, market_line, bookmaker, fetched_at,
           case market when 'h2h' then 'home' when 'totals' then 'over' else 'btts_yes' end as selection,
           home_odds as odds
      from freshest where home_odds is not null
    union all
    select match_id, market, market_line, bookmaker, fetched_at,
           'draw', draw_odds
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
           jsonb_object_agg(
             selection,
             jsonb_build_object('odds', odds, 'book', bookmaker, 'at', fetched_at)
           ) as prices
      from best
     group by 1, 2, 3
  ),
  depth as (
    select match_id, market, market_line,
           count(distinct bookmaker)::int as books,
           max(fetched_at) as last_seen
      from freshest
     group by 1, 2, 3
  )
  select jsonb_build_object(
           'match_id',    d.match_id,
           'market',      d.market,
           'market_line', d.market_line,
           'books',       d.books,
           'last_seen',   d.last_seen,
           'prices',      coalesce(p.prices, '{}'::jsonb)
         )
    from depth d
    left join priced p
      on p.match_id = d.match_id
     and p.market = d.market
     and coalesce(p.market_line, -1e9) = coalesce(d.market_line, -1e9)
   order by d.match_id, d.market;
$function$;
