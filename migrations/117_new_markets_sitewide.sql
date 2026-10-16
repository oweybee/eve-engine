-- 117: the new markets site-wide (betslip settlement, best prices, fair
-- probabilities, corners/cards history).
--
-- RECORD ONLY. Applied directly to production via the Supabase MCP on
-- 16 Oct 2026. Must NOT be re-run. pg_get_functiondef() (and pg_get_viewdef()
-- for the views) in the database is the source of truth; if it disagrees with
-- this file, the database wins.
--
-- Applied as (schema_migrations version, name):
--   20261016171226  new_markets_sitewide_117
--   20261016171258  best_prices_extra_split_117b
--   20261016171315  match_extras_history_117c
--   20261016171336  settle_pending_void_nostats_117d
--   20261016171345  v_match_extras_117e
--   20261016171504  v_odds_extra_history_117f
--
-- Objects:
--   bets_market_check            bets may carry dc, dnb, ah, corners, cards,
--                                bookings as well as h2h, totals, btts
--   public.bet_leg_outcome(...)  user bets, slips and acca legs grade through
--                                grade_selection()
--   public.settle_my_bets()      singles and accas, any market
--   public.match_extras_due()    (rewritten twice, final form 117c) every
--                                completed match back to 6 Aug 2026, pending
--                                settlements first
--   public.v_best_prices_extra   best price per selection for the new markets
--                                (v_best_prices left exactly as the boards read it)
--   public.v_market_fair_probs   Pinnacle-derived fair probability per selection
--   public.v_match_extras        per-match corners/cards for hit rates
--   public.v_odds_extra_history  price history for the new markets
--   public.settle_pending_signals()  (117d) voids corners/cards signals with no
--                                stats 3 days after kickoff
--   edge function match-extras   supabase/functions/match-extras (deployed
--       version 3, recorded alongside this file). pg_cron 'match-extras' calls
--       it every 10 minutes; it fetches total corners and cards per completed
--       match from API-Football into match_extra_stats, backfilling to
--       6 Aug 2026, then runs settle_new_market_paper_trades() and
--       settle_pending_signals().
--
-- OPEN SECURITY ITEM (recorded 16 Oct 2026, NOT fixed here; owner to apply).
-- anon and authenticated hold INSERT, UPDATE, DELETE and TRUNCATE (plus
-- SELECT, REFERENCES, TRIGGER) on match_extra_stats, odds_extra,
-- odds_extra_latest and the four new views (v_best_prices_extra,
-- v_market_fair_probs, v_match_extras, v_odds_extra_history). On the three
-- TABLES, RLS is on with no policies, so direct writes are denied (TRUNCATE is
-- never governed by RLS, but PostgREST exposes no TRUNCATE verb). The hole is
-- v_odds_extra_history: it is a simple auto-updatable view
-- (information_schema reports is_insertable_into = YES, is_updatable = YES)
-- running with its OWNER's rights (no security_invoker), so an anon DELETE,
-- UPDATE or INSERT through it reaches odds_extra and bypasses RLS. The other
-- three views are not updatable. Proposed fix:
--
--   revoke insert, update, delete, truncate on public.v_odds_extra_history,
--     public.v_best_prices_extra, public.v_market_fair_probs,
--     public.v_match_extras, public.match_extra_stats, public.odds_extra,
--     public.odds_extra_latest from anon, authenticated;
--
-- The applied statements are reproduced below for reference only, verbatim
-- from supabase_migrations.schema_migrations, each preceded by its version and
-- name and checked against md5(statements[1]) at the time of recording.

-- 20261016171226 new_markets_sitewide_117
-- 117: the new markets usable across the site: betslip / My Bets settlement,
-- best prices for the boards, and fair probabilities for predictions.

-- Bets may now carry the new markets ('cards' kept for existing rows; 'bookings' accepted too).
alter table public.bets drop constraint if exists bets_market_check;
alter table public.bets add constraint bets_market_check
  check (market = any (array['h2h','totals','btts','corners','cards','bookings','dc','dnb','ah']));

-- One grading path for user bets, slips and acca legs: grade_selection().
create or replace function public.bet_leg_outcome(p_market text, p_selection text, p_line numeric,
                                                  p_home integer, p_away integer,
                                                  p_corners integer default null, p_cards integer default null)
returns text language sql immutable
set search_path to 'public', 'pg_catalog'
as $f$
  select case public.grade_selection(
           case lower(p_market) when 'cards' then 'bookings' else lower(p_market) end,
           case
             when lower(p_market) = 'btts' and lower(p_selection) like '%yes%' then 'btts_yes'
             when lower(p_market) = 'btts' and lower(p_selection) like '%no%'  then 'btts_no'
             else lower(p_selection) end,
           p_line, p_home, p_away, p_corners, p_cards)
         when 'win' then 'won' when 'loss' then 'lost' when 'void' then 'void' end
$f$;

create or replace function public.settle_my_bets()
returns integer language plpgsql security definer
set search_path to 'public', 'pg_catalog'
as $function$
declare
  v_uid   uuid := auth.uid();
  r       record;
  v_new   text;
  v_close numeric;
  v_clv   numeric;
  v_count integer := 0;
  v_lost  integer; v_won_n integer; v_void_n integer; v_legs integer;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;

  for r in
    select b.id, b.market, b.selection, b.market_line, b.odds_taken, b.signal_id,
           m.goals_home, m.goals_away, s.corners, s.cards
    from public.bets b
    join public.matches m on m.id = b.match_id
    left join public.match_extra_stats s on s.match_id = m.id
    where b.user_id = v_uid and b.status = 'open'
      and coalesce(b.settle_mode, '') <> 'manual' and b.is_acca = false
      and m.status = 'completed' and m.goals_home is not null and m.goals_away is not null
  loop
    v_new := public.bet_leg_outcome(r.market, r.selection, r.market_line, r.goals_home, r.goals_away, r.corners, r.cards);
    if v_new is null then continue; end if;   -- cannot grade yet (e.g. corners stats not in)

    v_close := null; v_clv := null;
    if r.signal_id is not null then
      select vs.closing_odds into v_close from public.value_signals vs where vs.id = r.signal_id;
      if v_close is not null and v_close > 1 and r.odds_taken > 1 then v_clv := ln(r.odds_taken / v_close); end if;
    end if;

    update public.bets
       set status = v_new, settled_at = now(), settle_mode = 'auto',
           closing_odds = coalesce(closing_odds, v_close), clv = coalesce(clv, v_clv)
     where id = r.id;
    v_count := v_count + 1;
  end loop;

  for r in
    select b.id, b.acca_legs from public.bets b
    where b.user_id = v_uid and b.status = 'open' and coalesce(b.settle_mode, '') <> 'manual'
      and b.is_acca = true and jsonb_typeof(b.acca_legs) = 'array' and jsonb_array_length(b.acca_legs) > 0
      and not exists (select 1 from jsonb_array_elements(b.acca_legs) l where nullif(l->>'match_id', '') is null)
  loop
    select count(*), count(*) filter (where o.outcome = 'lost'), count(*) filter (where o.outcome = 'won'),
           count(*) filter (where o.outcome = 'void')
      into v_legs, v_lost, v_won_n, v_void_n
    from jsonb_array_elements(r.acca_legs) l
    left join public.matches m on m.id = (l->>'match_id')::uuid
    left join public.match_extra_stats s on s.match_id = m.id
    cross join lateral (
      select case when m.status = 'completed' then
        public.bet_leg_outcome(l->>'market', l->>'selection', nullif(l->>'market_line', '')::numeric,
                               m.goals_home, m.goals_away, s.corners, s.cards)
      end as outcome) o;

    if v_lost > 0 then v_new := 'lost';
    elsif v_won_n + v_void_n = v_legs and v_won_n > 0 then v_new := 'won';   -- a void leg drops out at odds 1
    elsif v_void_n = v_legs then v_new := 'void';
    else continue;
    end if;

    update public.bets set status = v_new, settled_at = now(), settle_mode = 'auto' where id = r.id;
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$function$;

-- Corners/cards stats are now fetched for any match that needs them: paper trades,
-- pending published signals, and open user bets.
create or replace function public.match_extras_due()
returns table(match_id uuid, external_id text)
language sql stable security definer
set search_path to 'public', 'pg_catalog'
as $f$
  select m.id, m.external_id
  from public.matches m
  where m.status = 'completed' and m.external_id ~ '^\d+$'
    and m.kickoff_at < now() - interval '2 hours' and m.kickoff_at > now() - interval '10 days'
    and not exists (select 1 from public.match_extra_stats s where s.match_id = m.id)
    and (exists (select 1 from public.paper_trades pt where pt.match_id = m.id and pt.result = 'pending' and pt.market in ('corners','cards'))
      or exists (select 1 from public.value_signals v where v.match_id = m.id and v.result = 'pending' and v.market in ('corners','bookings'))
      or exists (select 1 from public.bets b where b.match_id = m.id and b.status = 'open' and b.market in ('corners','cards','bookings'))
      or exists (select 1 from public.bets b, jsonb_array_elements(case when b.is_acca then b.acca_legs else '[]'::jsonb end) l
                  where b.status = 'open' and (l->>'match_id') = m.id::text and l->>'market' in ('corners','cards','bookings')))
  limit 60
$f$;

-- Best prices for every market (boards, hit-rate cards, slip prices).
create or replace view public.v_best_prices as
 SELECT ol.match_id, q.market, q.line, q.selection,
    max(q.price) AS best_odds, count(DISTINCT ol.bookmaker) AS books, max(ol.confirmed_at) AS read_at
   FROM odds_latest ol
     JOIN matches m ON m.id = ol.match_id
     CROSS JOIN LATERAL ( VALUES ('h2h'::text,NULL::numeric,'home'::text,ol.home_odds), ('h2h'::text,NULL::numeric,'draw'::text,ol.draw_odds), ('h2h'::text,NULL::numeric,'away'::text,ol.away_odds), ('totals'::text,ol.market_line,'over'::text,ol.home_odds), ('totals'::text,ol.market_line,'under'::text,ol.away_odds), ('btts'::text,NULL::numeric,'btts_yes'::text,ol.home_odds), ('btts'::text,NULL::numeric,'btts_no'::text,ol.away_odds)) q(market, line, selection, price)
  WHERE q.market = ol.market AND (ol.market = ANY (ARRAY['h2h'::text, 'totals'::text, 'btts'::text])) AND (ol.market_line IS NULL OR (ol.market_line = ANY (ARRAY[1.5, 2.5, 3.5]))) AND is_takeable_book(ol.bookmaker) AND ol.confirmed_at > (now() - COALESCE(price_max_age(EXTRACT(epoch FROM m.kickoff_at - now()) / 3600.0), '00:15:00'::interval)) AND q.price IS NOT NULL AND q.price > 1::numeric AND NOT odds_latest_is_frozen(ol.match_id, ol.bookmaker, ol.market, ol.market_line, ol.price_since)
  GROUP BY ol.match_id, q.market, q.line, q.selection
UNION ALL
 SELECT ox.match_id, q.market, q.line, q.selection,
    max(q.price), count(DISTINCT ox.bookmaker), max(ox.confirmed_at)
   FROM odds_extra_latest ox
     JOIN matches m ON m.id = ox.match_id
     CROSS JOIN LATERAL ( VALUES
       ('dc'::text, NULL::numeric, 'dc_1x'::text, ox.home_odds), ('dc', NULL, 'dc_12', ox.draw_odds), ('dc', NULL, 'dc_x2', ox.away_odds),
       ('dnb', NULL, 'dnb_home', ox.home_odds), ('dnb', NULL, 'dnb_away', ox.away_odds),
       ('ah', ox.market_line, 'ah_home', ox.home_odds), ('ah', ox.market_line, 'ah_away', ox.away_odds),
       ('corners', ox.market_line, 'over', ox.home_odds), ('corners', ox.market_line, 'under', ox.away_odds),
       ('bookings', ox.market_line, 'over', ox.home_odds), ('bookings', ox.market_line, 'under', ox.away_odds)) q(market, line, selection, price)
  WHERE q.market = (CASE ox.market WHEN 'cards' THEN 'bookings' ELSE ox.market END)
    AND is_takeable_book(ox.bookmaker)
    AND ox.confirmed_at > (now() - COALESCE(price_max_age(EXTRACT(epoch FROM m.kickoff_at - now()) / 3600.0), '00:15:00'::interval))
    AND q.price IS NOT NULL AND q.price > 1::numeric
  GROUP BY ox.match_id, q.market, q.line, q.selection;

-- Fair (margin-free) probability per selection for the new markets, from Pinnacle.
-- For predictions / "chance" displays. DC and DNB are derived from Pinnacle's 1X2.
create or replace view public.v_market_fair_probs as
with p3 as (
  select ol.match_id, public.shin_devig(array[ol.home_odds, ol.draw_odds, ol.away_odds]::float8[]) as p, ol.confirmed_at
  from public.odds_latest ol where ol.bookmaker = 'pinnacle' and ol.market = 'h2h'
),
p2 as (
  select ox.match_id, case ox.market when 'cards' then 'bookings' else ox.market end as market, ox.market_line,
         public.shin_devig(array[ox.home_odds, ox.away_odds]::float8[]) as p, ox.confirmed_at
  from public.odds_extra_latest ox where ox.bookmaker = 'pinnacle' and ox.market in ('ah', 'corners', 'cards')
)
select match_id, 'dc'::text as market, null::numeric as line, s.sel as selection, round(s.prob::numeric, 4) as fair_prob,
       round((1 / s.prob)::numeric, 3) as fair_odds, confirmed_at as read_at
from p3 cross join lateral (values ('dc_1x', p[1] + p[2]), ('dc_12', p[1] + p[3]), ('dc_x2', p[2] + p[3])) s(sel, prob)
where p is not null
union all
select match_id, 'dnb', null, s.sel, round(s.prob::numeric, 4), round((1 / s.prob)::numeric, 3), confirmed_at
from p3 cross join lateral (values ('dnb_home', p[1] / (p[1] + p[3])), ('dnb_away', p[3] / (p[1] + p[3]))) s(sel, prob)
where p is not null
union all
select match_id, market, market_line, s.sel, round(s.prob::numeric, 4), round((1 / s.prob)::numeric, 3), confirmed_at
from p2 cross join lateral (values (case when market = 'ah' then 'ah_home' else 'over' end, p[1]),
                                   (case when market = 'ah' then 'ah_away' else 'under' end, p[2])) s(sel, prob)
where p is not null;

grant select on public.v_best_prices, public.v_market_fair_probs to anon, authenticated;

-- 20261016171258 best_prices_extra_split_117b
-- Keep v_best_prices exactly as the live boards read it (one page per 24 fixtures,
-- unordered paging). The new markets get their own view instead.
create or replace view public.v_best_prices_extra as
 SELECT ox.match_id, q.market, q.line, q.selection,
    max(q.price) AS best_odds, count(DISTINCT ox.bookmaker) AS books, max(ox.confirmed_at) AS read_at
   FROM odds_extra_latest ox
     JOIN matches m ON m.id = ox.match_id
     CROSS JOIN LATERAL ( VALUES
       ('dc'::text, NULL::numeric, 'dc_1x'::text, ox.home_odds), ('dc', NULL, 'dc_12', ox.draw_odds), ('dc', NULL, 'dc_x2', ox.away_odds),
       ('dnb', NULL, 'dnb_home', ox.home_odds), ('dnb', NULL, 'dnb_away', ox.away_odds),
       ('ah', ox.market_line, 'ah_home', ox.home_odds), ('ah', ox.market_line, 'ah_away', ox.away_odds),
       ('corners', ox.market_line, 'over', ox.home_odds), ('corners', ox.market_line, 'under', ox.away_odds),
       ('bookings', ox.market_line, 'over', ox.home_odds), ('bookings', ox.market_line, 'under', ox.away_odds)) q(market, line, selection, price)
  WHERE q.market = (CASE ox.market WHEN 'cards' THEN 'bookings' ELSE ox.market END)
    AND is_takeable_book(ox.bookmaker)
    AND ox.confirmed_at > (now() - COALESCE(price_max_age(EXTRACT(epoch FROM m.kickoff_at - now()) / 3600.0), '00:15:00'::interval))
    AND q.price IS NOT NULL AND q.price > 1::numeric
  GROUP BY ox.match_id, q.market, q.line, q.selection;

create or replace view public.v_best_prices as
 SELECT ol.match_id, q.market, q.line, q.selection,
    max(q.price) AS best_odds, count(DISTINCT ol.bookmaker) AS books, max(ol.confirmed_at) AS read_at
   FROM odds_latest ol
     JOIN matches m ON m.id = ol.match_id
     CROSS JOIN LATERAL ( VALUES ('h2h'::text,NULL::numeric,'home'::text,ol.home_odds), ('h2h'::text,NULL::numeric,'draw'::text,ol.draw_odds), ('h2h'::text,NULL::numeric,'away'::text,ol.away_odds), ('totals'::text,ol.market_line,'over'::text,ol.home_odds), ('totals'::text,ol.market_line,'under'::text,ol.away_odds), ('btts'::text,NULL::numeric,'btts_yes'::text,ol.home_odds), ('btts'::text,NULL::numeric,'btts_no'::text,ol.away_odds)) q(market, line, selection, price)
  WHERE q.market = ol.market AND (ol.market = ANY (ARRAY['h2h'::text, 'totals'::text, 'btts'::text])) AND (ol.market_line IS NULL OR (ol.market_line = ANY (ARRAY[1.5, 2.5, 3.5]))) AND is_takeable_book(ol.bookmaker) AND ol.confirmed_at > (now() - COALESCE(price_max_age(EXTRACT(epoch FROM m.kickoff_at - now()) / 3600.0), '00:15:00'::interval)) AND q.price IS NOT NULL AND q.price > 1::numeric AND NOT odds_latest_is_frozen(ol.match_id, ol.bookmaker, ol.market, ol.market_line, ol.price_since)
  GROUP BY ol.match_id, q.market, q.line, q.selection;

grant select on public.v_best_prices_extra to anon, authenticated;

-- 20261016171315 match_extras_history_117c
-- Corners/cards for EVERY completed match (hit rates need history, not just the
-- matches we have bets on). Matches with pending settlement come first, then the
-- backfill back to 6 Aug 2026 (mx_team_match covers before that), newest first.
create or replace function public.match_extras_due()
returns table(match_id uuid, external_id text)
language sql stable security definer
set search_path to 'public', 'pg_catalog'
as $f$
  select m.id, m.external_id
  from public.matches m
  where m.status = 'completed' and m.external_id ~ '^\d+$'
    and m.kickoff_at < now() - interval '2 hours' and m.kickoff_at > '2026-08-06'
    and not exists (select 1 from public.match_extra_stats s where s.match_id = m.id)
  order by
    (exists (select 1 from public.paper_trades pt where pt.match_id = m.id and pt.result = 'pending' and pt.market in ('corners','cards'))
     or exists (select 1 from public.value_signals v where v.match_id = m.id and v.result = 'pending' and v.market in ('corners','bookings'))
     or exists (select 1 from public.bets b where b.match_id = m.id and b.status = 'open')) desc,
    m.kickoff_at desc
  limit 60
$f$;
select cron.unschedule('match-extras-hourly');
select cron.schedule('match-extras', '*/10 * * * *',
  (select replace(command, '/functions/v1/refresh-odds', '/functions/v1/match-extras') from cron.job where jobname = 'refresh-odds'));

-- 20261016171336 settle_pending_void_nostats_117d
grant execute on function public.settle_pending_signals() to service_role;
-- A corners/cards signal whose match has no stats 3 days after kickoff is voided,
-- never left pending for ever and never guessed.
create or replace function public.settle_pending_signals()
returns integer language plpgsql security definer
set search_path to 'public', 'pg_catalog'
as $f$
declare r record; n int := 0;
begin
  for r in
    select distinct v.match_id from public.value_signals v join public.matches m on m.id = v.match_id
    where v.result = 'pending' and m.status = 'completed' and m.goals_home is not null
      and coalesce(v.phase, 'prematch') = 'prematch'
  loop
    perform public.settle_match_signals(r.match_id);
    n := n + 1;
  end loop;

  update public.value_signals v set result = 'void', score_withheld_reason = coalesce(v.score_withheld_reason, '')
  from public.matches m
  where m.id = v.match_id and v.result = 'pending' and v.market in ('corners', 'bookings')
    and m.status = 'completed' and m.kickoff_at < now() - interval '3 days'
    and not exists (select 1 from public.match_extra_stats s where s.match_id = m.id and s.corners is not null);
  return n;
end $f$;

-- 20261016171345 v_match_extras_117e
-- Read-only per-match corners/cards for hit rates (frontend), alongside matches' goals.
create or replace view public.v_match_extras as
select m.id as match_id, m.kickoff_at, m.home_team_id, m.away_team_id, m.league_id,
       m.goals_home, m.goals_away, s.corners, s.cards, s.yellow, s.red
from public.matches m join public.match_extra_stats s on s.match_id = m.id
where m.status = 'completed' and s.corners is not null;
grant select on public.v_match_extras, public.v_market_fair_probs to anon, authenticated;

-- 20261016171504 v_odds_extra_history_117f
-- Price-change history for the new markets (Market Pulse movers, price charts).
-- Same shape as `odds`; UK-licensed books only, as everywhere a reader can see.
create or replace view public.v_odds_extra_history as
select match_id, bookmaker, case market when 'cards' then 'bookings' else market end as market, market_line,
       home_odds, draw_odds, away_odds, fetched_at
from public.odds_extra
where public.is_takeable_book(bookmaker);
grant select on public.v_odds_extra_history to anon, authenticated;
