-- 149: only a book a UK reader can open may be shown as the best price.
--
-- WHY (14 Oct 2026). The Man City v PSG card on /fixtures showed 1X2 prices of
-- 2.21 / 4.20 / 3.42 and an EDGE +5.4% badge against a fair 2.10. The 2.21 was
-- dafabet and the 4.20 and 3.42 were 1xbet. No UK reader can take either, and
-- every UK book sat at 1.95 to 2.07 on City.
--
-- Two read paths had no bookmaker filter at all:
--   fixture_board()  took the max over EVERY row in `odds`, including pinnacle
--                    (the anchor), 1xbet, the exchanges and the synthetic
--                    `best` row that lib/marketAnchor already excludes.
--   v_best_prices    the same, over odds_latest.
--
-- The engine side of the same fix is lib/marketAnchor TAKEABLE_BOOKS: the
-- panel still COUNTS dafabet, sbo and marathonbet for the six-book floor
-- (0 of 203 upcoming fixtures clear it without them), but they can no longer
-- SET a price. This function is that list, so SQL and JS say the same thing.
-- Keep it in step with TAKEABLE_BOOKS.

create or replace function public.is_takeable_book(p_book text)
returns boolean
language sql
immutable parallel safe
set search_path to 'public', 'pg_catalog'
as $$
  select lower(coalesce(p_book, '')) = any (array[
    'bet365', 'williamhill', 'betvictor', 'unibet_uk', 'betfair_sb_uk',
    'paddypower', 'skybet', 'betano', '10bet'
  ]);
$$;

comment on function public.is_takeable_book(text) is
  'True for books a UK reader can hold an account with. Mirrors eve-engine lib/marketAnchor TAKEABLE_BOOKS (migration 149).';

create or replace function public.fixture_board(p_from timestamp with time zone, p_to timestamp with time zone, p_limit integer default 200)
 returns setof jsonb
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
 set work_mem to '32MB'
as $function$
  with fixtures as (
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
           and public.is_takeable_book(o.bookmaker)   -- 149
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

create or replace view public.v_best_prices as
 select ol.match_id,
    q.market,
    q.line,
    q.selection,
    max(q.price) as best_odds,
    count(distinct ol.bookmaker) as books,
    max(ol.confirmed_at) as read_at
   from odds_latest ol
     join matches m on m.id = ol.match_id
     cross join lateral ( values ('h2h'::text,null::numeric,'home'::text,ol.home_odds), ('h2h'::text,null::numeric,'draw'::text,ol.draw_odds), ('h2h'::text,null::numeric,'away'::text,ol.away_odds), ('totals'::text,ol.market_line,'over'::text,ol.home_odds), ('totals'::text,ol.market_line,'under'::text,ol.away_odds), ('btts'::text,null::numeric,'btts_yes'::text,ol.home_odds), ('btts'::text,null::numeric,'btts_no'::text,ol.away_odds)) q(market, line, selection, price)
  where q.market = ol.market
    and (ol.market = any (array['h2h'::text, 'totals'::text, 'btts'::text]))
    and (ol.market_line is null or (ol.market_line = any (array[1.5, 2.5, 3.5])))
    and public.is_takeable_book(ol.bookmaker)   -- 149
    and ol.confirmed_at > (now() - coalesce(price_max_age(extract(epoch from m.kickoff_at - now()) / 3600.0), '00:15:00'::interval))
    and q.price is not null and q.price > 1::numeric
    and not odds_latest_is_frozen(ol.match_id, ol.bookmaker, ol.market, ol.market_line, ol.price_since)
  group by ol.match_id, q.market, q.line, q.selection;
