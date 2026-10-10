-- 139 - a price is fresh when we last SAW it, not when it last MOVED
--
-- ── WHAT WAS FOUND ON 10 OCT 2026 ────────────────────────────────────────────
--
-- The hit-rate board said "No price yet" on Eintracht Frankfurt v 1. FC Koln
-- while the match page beside it showed BTTS Yes at 1.40. Both were reading
-- the same row: the newest `odds` row for that fixture was 25 hours old.
--
-- `v_best_prices` (130) keeps a quote only if it was WRITTEN in the last six
-- hours. But `odds` is a price-CHANGE log: `ingestOdds` writes a row only when
-- the price moved. A quote we re-confirmed an hour ago that did not move is,
-- to this table, as old as the last time it moved. Far-out prices rarely
-- move, so across the next seven days:
--
--   kickoff     priced   inside 6h (shown)   inside 36h
--   < 24h          156         151                156
--   1 - 3 days     120          79                119
--   3 - 7 days      87          46                 87
--
-- about 87 fixtures read "No price yet" while their match page showed one.
--
-- ── WHAT THIS DOES ───────────────────────────────────────────────────────────
--
-- `odds_latest` holds the CURRENT quote per (match, book, market, line) and
-- `confirmed_at`, the last time a poll saw it. ingestOdds upserts every quote
-- it reads, moved or not. `odds` is untouched: it remains the price-move
-- record that CLV, takeability and the closing lines are measured from.
--
-- `v_best_prices` now judges freshness on `confirmed_at`. The six-hour window
-- is unchanged; the polling ladder was tightened in the same release so every
-- fixture inside a fortnight is confirmed well within it.
--
-- ── GATING ───────────────────────────────────────────────────────────────────
--
-- `odds_latest` carries the SAME tier policy as `odds`: which book quotes what
-- is the member's product. The view still runs as its owner (as 130 does) and
-- publishes the best price and the book COUNT to every seat, never the name.
-- The client roles get SELECT only; writes are service_role, per the 7 Aug
-- revoke rule.
--
-- The unique key is NULLS NOT DISTINCT so a null market_line collides with
-- itself and the plain column list is a usable ON CONFLICT target (087).

create table if not exists public.odds_latest (
  match_id     uuid        not null references public.matches(id) on delete cascade,
  bookmaker    text        not null,
  market       text        not null,
  market_line  numeric,
  home_odds    numeric     not null,
  draw_odds    numeric,
  away_odds    numeric     not null,
  confirmed_at timestamptz not null,
  constraint odds_latest_key unique nulls not distinct (match_id, bookmaker, market, market_line)
);

create index if not exists odds_latest_confirmed_idx on public.odds_latest (confirmed_at);

alter table public.odds_latest enable row level security;

drop policy if exists tiered_read_odds_latest on public.odds_latest;
create policy tiered_read_odds_latest on public.odds_latest
  for select to anon, authenticated
  using (
    ((select public.current_tier()) <> 'free')
    or (match_id in (select public.preview_priced_match_ids()))
  );

revoke all on public.odds_latest from anon, authenticated;
grant select on public.odds_latest to anon, authenticated;

-- Seed from the log: the newest row per key for every upcoming fixture, as
-- confirmed at the time it was written. Honest about age; the first polls
-- after deploy bring it current.
insert into public.odds_latest
  (match_id, bookmaker, market, market_line, home_odds, draw_odds, away_odds, confirmed_at)
select distinct on (o.match_id, o.bookmaker, o.market, o.market_line)
       o.match_id, o.bookmaker, o.market, o.market_line,
       o.home_odds, o.draw_odds, o.away_odds, o.fetched_at
  from public.odds o
  join public.matches m on m.id = o.match_id
 where m.kickoff_at > now()
   and o.fetched_at > now() - interval '14 days'
   and o.bookmaker <> 'apifootball_live'
 order by o.match_id, o.bookmaker, o.market, o.market_line, o.fetched_at desc
on conflict on constraint odds_latest_key do nothing;

create or replace view public.v_best_prices as
with fresh as (
  select match_id, bookmaker, market, market_line, home_odds, draw_odds, away_odds,
         confirmed_at as fetched_at
    from public.odds_latest
   where confirmed_at > now() - interval '6 hours'
     and market = any (array['h2h', 'totals', 'btts'])
     and (market_line is null or market_line = any (array[1.5, 2.5, 3.5]))
), quotes as (
  select match_id, bookmaker, 'h2h'::text as market, null::numeric as line, 'home'::text as selection, home_odds as price, fetched_at from fresh where market = 'h2h'
  union all
  select match_id, bookmaker, 'h2h', null, 'draw', draw_odds, fetched_at from fresh where market = 'h2h'
  union all
  select match_id, bookmaker, 'h2h', null, 'away', away_odds, fetched_at from fresh where market = 'h2h'
  union all
  select match_id, bookmaker, 'totals', market_line, 'over', home_odds, fetched_at from fresh where market = 'totals'
  union all
  select match_id, bookmaker, 'totals', market_line, 'under', away_odds, fetched_at from fresh where market = 'totals'
  union all
  select match_id, bookmaker, 'btts', null, 'btts_yes', home_odds, fetched_at from fresh where market = 'btts'
  union all
  select match_id, bookmaker, 'btts', null, 'btts_no', away_odds, fetched_at from fresh where market = 'btts'
)
select match_id, market, line, selection,
       max(price) as best_odds,
       count(distinct bookmaker) as books,
       max(fetched_at) as read_at
  from quotes
 where price is not null and price > 1
 group by match_id, market, line, selection;

do $$
declare
  n_latest int;
  n_anon_write int;
begin
  select count(*) into n_latest from public.odds_latest;
  if n_latest = 0 then
    raise exception '[139] odds_latest seeded empty';
  end if;
  select count(*) into n_anon_write
    from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'odds_latest'
     and grantee in ('anon', 'authenticated')
     and privilege_type <> 'SELECT';
  if n_anon_write > 0 then
    raise exception '[139] a client role can write odds_latest';
  end if;
end $$;
