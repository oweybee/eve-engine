-- 141 - a price has an AGE, and a frozen book is not a price
--
-- ── WHAT WAS FOUND ON 11 OCT 2026 ────────────────────────────────────────────
--
-- Liverpool v Man City, 51 minutes to kickoff. The Prices tab showed Bet365
-- Liverpool 3.20; Bet365's app showed 3.40. Three separate faults:
--
-- 1. AGE IS INVISIBLE. `odds_latest.confirmed_at` is the last time a poll SAW
--    the quote. API-Football serves bookmaker prices in batches; every book on
--    this fixture last changed at 14:07 UTC and every poll after that re-served
--    the same batch with a new `confirmed_at`. The page looked fresh while the
--    price was half an hour behind the book.
--
-- 2. FROZEN BOOKS SKEW THE PANEL. Betfair SB had held Liverpool at 2.90 since
--    00:59 UTC on 10 Oct and Dafabet at 2.95 since 08:19 UTC, while every other
--    book on the fixture drifted 2.90 -> 3.30. Their -11.3% / -9.7% "against
--    fair" were artefacts of a feed that stopped updating them, not prices
--    anyone could get.
--
-- 3. (Engine side, fixed in the same PR) `prefetchLastOdds` read `odds` without
--    paging, PostgREST capped it at 1,000 rows, so most (book, market) keys
--    looked never-seen and were re-inserted EVERY poll. 17k rows on 7 Oct,
--    466k on 10 Oct: the growth fed the truncation that caused it.
--
-- ── WHAT THIS DOES ───────────────────────────────────────────────────────────
--
-- * `odds_latest.price_since`: when the CURRENT quote first appeared. Kept by a
--   trigger, so the engine needs no change to maintain it: an upsert with the
--   same prices keeps the old value, a changed price resets it.
-- * `v_odds_latest_status`: every live quote with its age and two flags,
--     is_frozen      the book has held this price for 6h+ while at least half
--                    the other books on the same market (min 2) repriced 3h+
--                    after it did. "Has not moved while the market has."
--     is_indicative  kickoff is inside two hours: prices move ~5x faster per
--                    hour there and our feed is batched, so treat as a guide.
-- * `v_best_prices` and `v_signal_price_check` ignore frozen quotes, so a stuck
--   book can neither win BEST nor keep a signal "live".
--
-- `odds` is untouched.

alter table public.odds_latest add column if not exists price_since timestamptz;

create or replace function public.odds_latest_keep_price_since()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.price_since := coalesce(new.price_since, new.confirmed_at);
  elsif new.home_odds is distinct from old.home_odds
     or new.draw_odds is distinct from old.draw_odds
     or new.away_odds is distinct from old.away_odds then
    new.price_since := new.confirmed_at;
  else
    new.price_since := coalesce(old.price_since, new.confirmed_at);
  end if;
  return new;
end $$;

revoke all on function public.odds_latest_keep_price_since() from public, anon, authenticated;

drop trigger if exists odds_latest_price_since on public.odds_latest;
create trigger odds_latest_price_since
  before insert or update on public.odds_latest
  for each row execute function public.odds_latest_keep_price_since();

-- Backfill, upcoming fixtures: the start of the trailing run of identical
-- prices in the `odds` log. Everything else takes confirmed_at (honest lower
-- bound on age; the trigger owns it from here).
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
 where m.id = ol.match_id and m.kickoff_at > now();

update public.odds_latest set price_since = confirmed_at where price_since is null;

alter table public.odds_latest alter column price_since set not null;

-- Runs as the caller: which book quotes what is tiered (139), and this view
-- names books.
create or replace view public.v_odds_latest_status
with (security_invoker = true) as
select ol.match_id, ol.bookmaker, ol.market, ol.market_line,
       ol.home_odds, ol.draw_odds, ol.away_odds,
       ol.confirmed_at, ol.price_since,
       now() - ol.price_since as price_age,
       (ol.price_since < now() - interval '6 hours'
        and peers.moved_after >= greatest(2, ceil(peers.others / 2.0))) as is_frozen,
       (m.kickoff_at - now() < interval '2 hours') as is_indicative,
       m.kickoff_at
  from public.odds_latest ol
  join public.matches m on m.id = ol.match_id
  cross join lateral (
    select count(*) as others,
           count(*) filter (where p.price_since > ol.price_since + interval '3 hours') as moved_after
      from public.odds_latest p
     where p.match_id = ol.match_id and p.market = ol.market
       and p.market_line is not distinct from ol.market_line
       and p.bookmaker <> ol.bookmaker and p.bookmaker <> 'apifootball_live'
  ) peers;

revoke all on public.v_odds_latest_status from anon, authenticated;
grant select on public.v_odds_latest_status to anon, authenticated;

-- One predicate both views share.
create or replace function public.odds_latest_is_frozen(p_match uuid, p_book text, p_market text,
                                                         p_line numeric, p_since timestamptz)
returns boolean
language sql stable
security definer
set search_path = public
as $$
  select p_since < now() - interval '6 hours'
     and count(*) filter (where p.price_since > p_since + interval '3 hours')
         >= greatest(2, ceil(count(*) / 2.0))
    from public.odds_latest p
   where p.match_id = p_match and p.market = p_market
     and p.market_line is not distinct from p_line
     and p.bookmaker <> p_book and p.bookmaker <> 'apifootball_live'
$$;

-- Definer: v_best_prices runs as its owner (130/139), so its frozen check must
-- see every book too, or a free seat would get a different BEST. Returns a
-- boolean only; names nothing.
revoke all on function public.odds_latest_is_frozen(uuid, text, text, numeric, timestamptz) from public;
grant execute on function public.odds_latest_is_frozen(uuid, text, text, numeric, timestamptz)
  to anon, authenticated, service_role;

create or replace view public.v_best_prices as
with fresh as (
  select ol.match_id, ol.bookmaker, ol.market, ol.market_line,
         ol.home_odds, ol.draw_odds, ol.away_odds, ol.confirmed_at as fetched_at
    from public.odds_latest ol
    join public.matches m on m.id = ol.match_id
   where ol.confirmed_at > now() - coalesce(public.price_max_age(extract(epoch from m.kickoff_at - now()) / 3600.0), interval '15 minutes')
     and ol.market = any (array['h2h', 'totals', 'btts'])
     and (ol.market_line is null or ol.market_line = any (array[1.5, 2.5, 3.5]))
     and not public.odds_latest_is_frozen(ol.match_id, ol.bookmaker, ol.market, ol.market_line, ol.price_since)
), quotes as (
  select match_id, bookmaker, 'h2h'::text as market, null::numeric as line, 'home'::text as selection, home_odds as price, fetched_at from fresh where market = 'h2h'
  union all select match_id, bookmaker, 'h2h', null, 'draw', draw_odds, fetched_at from fresh where market = 'h2h'
  union all select match_id, bookmaker, 'h2h', null, 'away', away_odds, fetched_at from fresh where market = 'h2h'
  union all select match_id, bookmaker, 'totals', market_line, 'over', home_odds, fetched_at from fresh where market = 'totals'
  union all select match_id, bookmaker, 'totals', market_line, 'under', away_odds, fetched_at from fresh where market = 'totals'
  union all select match_id, bookmaker, 'btts', null, 'btts_yes', home_odds, fetched_at from fresh where market = 'btts'
  union all select match_id, bookmaker, 'btts', null, 'btts_no', away_odds, fetched_at from fresh where market = 'btts'
)
select match_id, market, line, selection,
       max(price) as best_odds,
       count(distinct bookmaker) as books,
       max(fetched_at) as read_at
  from quotes
 where price is not null and price > 1
 group by match_id, market, line, selection;

create or replace view public.v_signal_price_check as
with p as (
  select v.id, v.match_id, v.market, v.outcome, v.detected_edge, v.detected_odds,
         v.model_prob, v.mxs, v.kickoff_at,
         (select max(case when v.outcome = any (array['home', 'over', 'btts_yes']) then ol.home_odds
                          when v.outcome = 'draw' then ol.draw_odds
                          else ol.away_odds end)
            from public.odds_latest ol
           where ol.match_id = v.match_id and ol.market = v.market
             and not ol.market_line is distinct from v.market_line
             and ol.bookmaker <> 'apifootball_live'
             and ol.confirmed_at > now() - coalesce(public.price_max_age(extract(epoch from v.kickoff_at - now()) / 3600.0), interval '15 minutes')
             and not public.odds_latest_is_frozen(ol.match_id, ol.bookmaker, ol.market, ol.market_line, ol.price_since)
         ) as best
    from public.value_signals v
   where coalesce(v.result, 'pending') = 'pending' and v.kickoff_at > now()
     and coalesce(v.phase, 'prematch') = 'prematch' and v.model_prob is not null
)
select id, match_id, market, outcome, detected_edge, detected_odds, model_prob, mxs, kickoff_at, best,
       case when best is null then null::numeric else round(model_prob * best - 1, 4) end as edge,
       case when best is null then 'stale'
            when (model_prob * best - 1) <= 0 then 'edge_gone'
            when best < detected_odds and (model_prob * best - 1) < (0.5 * coalesce(detected_edge, 0)) then 'shrunk'
            else 'live' end as st
  from p;

-- Exact last stored price per key, as ONE json value: not subject to the
-- 1,000-row response cap that broke prefetchLastOdds. Service role only.
create or replace function public.odds_last_per_key(p_match_ids uuid[], p_since timestamptz)
returns jsonb
language sql stable
set search_path = public
as $$
  select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
    from (
      select distinct on (match_id, market, market_line, bookmaker)
             match_id, bookmaker, market, market_line, home_odds, draw_odds, away_odds, fetched_at
        from public.odds
       where match_id = any (p_match_ids) and fetched_at >= p_since
       order by match_id, market, market_line, bookmaker, fetched_at desc
    ) t
$$;

revoke all on function public.odds_last_per_key(uuid[], timestamptz) from public, anon, authenticated;
grant execute on function public.odds_last_per_key(uuid[], timestamptz) to service_role;

do $$
declare n int;
begin
  select count(*) into n from public.odds_latest where price_since is null;
  if n > 0 then raise exception '[141] % odds_latest rows without price_since', n; end if;
end $$;
