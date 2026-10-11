-- 142 - three corrections to 141, all applied to production on 11 Oct 2026
--
-- 1. 141'S BACKFILL NEVER LANDED. It created the trigger BEFORE the backfill
--    UPDATE, and the trigger's unchanged-price branch keeps OLD.price_since,
--    which was null, so it fell back to confirmed_at on every row. Measured
--    after 141: 26,902 of 26,902 rows had price_since = confirmed_at. The
--    backfill below runs with the trigger disabled; afterwards 13,865 of
--    14,733 upcoming quotes carried a real start time (the rest have no
--    earlier identical row in `odds`, so confirmed_at is the honest bound).
--
-- 2. THE FROZEN RULE FLAGGED BOOKS THAT ARE SIMPLY SLOWER THAN PINNACLE.
--    "Held 6h while half the others repriced 3h later" counted ANY tick by
--    the other books, and Pinnacle ticks a penny all day. Over the markets the
--    site shows, kicking off inside 24h: 29% of quotes flagged, Bet365 32%.
--    A frozen book now also has to be more than 2 points of implied chance
--    away from the other books' median on at least one leg (Betfair SB at
--    2.90 against ~3.25 on 11 Oct was 3.7 points). Probability rather than a
--    price ratio, because a 15 against 13 longshot is 1 point and is not
--    stale. Result on the same set: 10% flagged, Bet365 5%, Pinnacle 0.
--    v_odds_latest_status now calls the same function, so the page and
--    v_best_prices cannot disagree about which book is frozen.
--
-- 3. v_best_prices COULD NOT BE FILTERED. Its seven-way UNION over a CTE
--    referenced seven times made the CTE materialise, so the app's
--    `match_id in (...)` reads scanned every live quote (17k) on every call.
--    With 141's frozen check per row that was 1.4s a call. Unpivoting with a
--    LATERAL VALUES list lets the filter push down: 180 ms for a 40-fixture
--    chunk, identical rows (3,489 over 323 matches before and after).

begin;

alter table public.odds_latest disable trigger odds_latest_price_since;

update public.odds_latest ol
   set price_since = coalesce((
         select min(o.fetched_at)
           from public.odds o
          where o.match_id = ol.match_id and o.bookmaker = ol.bookmaker
            and o.market = ol.market and o.market_line is not distinct from ol.market_line
            and o.home_odds = ol.home_odds and o.away_odds = ol.away_odds
            and o.draw_odds is not distinct from ol.draw_odds
            and o.fetched_at > coalesce((
                  select max(o2.fetched_at)
                    from public.odds o2
                   where o2.match_id = ol.match_id and o2.bookmaker = ol.bookmaker
                     and o2.market = ol.market and o2.market_line is not distinct from ol.market_line
                     and (o2.home_odds <> ol.home_odds or o2.away_odds <> ol.away_odds
                          or o2.draw_odds is distinct from ol.draw_odds)), '-infinity')
       ), ol.confirmed_at)
  from public.matches m
 where m.id = ol.match_id and m.kickoff_at > now()
   and ol.price_since = ol.confirmed_at;

alter table public.odds_latest enable trigger odds_latest_price_since;

create or replace function public.odds_latest_is_frozen(p_match uuid, p_book text, p_market text,
                                                         p_line numeric, p_since timestamptz)
returns boolean
language sql stable
security definer
set search_path = public
as $$
  select case when p_since is null or p_since >= now() - interval '6 hours' then false
  else coalesce((
    select o.moved >= greatest(2, ceil(o.n / 2.0))
       and (abs(1 / me.home_odds - o.mh) > 0.02
            or abs(1 / me.away_odds - o.ma) > 0.02
            or abs(1 / me.draw_odds - o.md) > 0.02)
      from public.odds_latest me
      cross join lateral (
        select count(*) as n,
               count(*) filter (where p.price_since > p_since + interval '3 hours') as moved,
               percentile_cont(0.5) within group (order by 1 / p.home_odds) as mh,
               percentile_cont(0.5) within group (order by 1 / p.draw_odds) as md,
               percentile_cont(0.5) within group (order by 1 / p.away_odds) as ma
          from public.odds_latest p
         where p.match_id = p_match and p.market = p_market
           and p.market_line is not distinct from p_line
           and p.bookmaker <> p_book and p.bookmaker <> 'apifootball_live'
      ) o
     where me.match_id = p_match and me.bookmaker = p_book and me.market = p_market
       and me.market_line is not distinct from p_line
     limit 1), false)
  end
$$;

create or replace view public.v_odds_latest_status
with (security_invoker = true) as
select ol.match_id, ol.bookmaker, ol.market, ol.market_line,
       ol.home_odds, ol.draw_odds, ol.away_odds,
       ol.confirmed_at, ol.price_since,
       now() - ol.price_since as price_age,
       coalesce(public.odds_latest_is_frozen(ol.match_id, ol.bookmaker, ol.market, ol.market_line, ol.price_since), false) as is_frozen,
       (m.kickoff_at - now() < interval '2 hours') as is_indicative,
       m.kickoff_at
  from public.odds_latest ol
  join public.matches m on m.id = ol.match_id;

create or replace view public.v_best_prices as
select ol.match_id, q.market, q.line, q.selection,
       max(q.price) as best_odds, count(distinct ol.bookmaker) as books, max(ol.confirmed_at) as read_at
  from public.odds_latest ol
  join public.matches m on m.id = ol.match_id
  cross join lateral (values
      ('h2h'::text, null::numeric, 'home'::text, ol.home_odds),
      ('h2h', null, 'draw', ol.draw_odds),
      ('h2h', null, 'away', ol.away_odds),
      ('totals', ol.market_line, 'over', ol.home_odds),
      ('totals', ol.market_line, 'under', ol.away_odds),
      ('btts', null, 'btts_yes', ol.home_odds),
      ('btts', null, 'btts_no', ol.away_odds)) q(market, line, selection, price)
 where q.market = ol.market
   and ol.market = any (array['h2h','totals','btts'])
   and (ol.market_line is null or ol.market_line = any (array[1.5, 2.5, 3.5]))
   and ol.confirmed_at > now() - coalesce(public.price_max_age(extract(epoch from m.kickoff_at - now()) / 3600.0), interval '15 minutes')
   and q.price is not null and q.price > 1
   and not public.odds_latest_is_frozen(ol.match_id, ol.bookmaker, ol.market, ol.market_line, ol.price_since)
 group by ol.match_id, q.market, q.line, q.selection;

commit;
