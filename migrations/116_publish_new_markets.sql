-- 116: publish the new markets to value_signals under MARKET_ANCHORED.
--
-- RECORD ONLY. Applied directly to production via the Supabase MCP on
-- 16 Oct 2026. Must NOT be re-run. pg_get_functiondef() (and pg_get_viewdef()
-- for the views) in the database is the source of truth; if it disagrees with
-- this file, the database wins.
--
-- Applied as (schema_migrations version, name):
--   20261016164606  publish_new_markets_116
--   20261016164711  new_markets_price_views_116b
--
-- Objects:
--   public.publish_new_market_signals()  writes pending MARKET_ANCHORED signals
--       for totals, double chance, draw no bet, Asian handicap, corners and
--       cards (cards stored as market 'bookings'); owner ruling 16 Oct 2026,
--       published without passing paper_trade_gate()
--   public.mes_raw(gap, sigma), public.mes_edge_efficiency(edge)
--       SQL port of lib/maxedge.js scoreSignal
--   public.selection_label(market, outcome, line, home, away)
--       reader text for every market; mirrored in this repo by
--       lib/selectionLabel.js (engine.selectionlabel.test.js)
--   public.quote_for(outcome, home, draw, away)
--   public.v_all_quotes_latest      odds_latest + odds_extra_latest, one shape
--   public.v_signal_price_check     live / shrunk / edge_gone / stale per
--                                   pending signal, every market
--   public.v_prime_alert_state      re-pointed at v_all_quotes_latest so PRIME
--                                   alerts cover the new markets
--
-- The applied statements are reproduced below for reference only, verbatim
-- from supabase_migrations.schema_migrations, each preceded by its version and
-- name and checked against md5(statements[1]) at the time of recording.

-- 20261016164606 publish_new_markets_116
-- 116: OWNER RULING 16 Oct 2026 ("add them all to the site, I'm happy to risk the
-- record"): totals, double chance, draw no bet, Asian handicap, corners and cards
-- are published to value_signals under MARKET_ANCHORED, without passing
-- paper_trade_gate. Backtest evidence at the time: research.bt_totals_multi_16oct,
-- research.bt_newmk_16oct (claude/new-markets-backtest-16-oct.md). The paper trial
-- keeps running alongside, unchanged.

-- SQL port of lib/maxedge.js scoreSignal (BASE 0.35, Z_GATE 1, edge efficiency).
create or replace function public.mes_edge_efficiency(p_edge numeric)
returns numeric language sql immutable as
$f$ select case
  when p_edge is null then 1
  when p_edge <= 0 then 0.40
  when p_edge < 0.05 then 0.40 + (p_edge / 0.05) * 0.35
  when p_edge < 0.07 then 1
  when p_edge < 0.10 then 0.85
  when p_edge < 0.12 then 0.85 - ((p_edge - 0.10) / 0.02) * (0.85 - 0.40)
  else 0.25 end $f$;

create or replace function public.mes_raw(p_gap numeric, p_sigma numeric)
returns integer language sql immutable as
$f$ select case
  when p_gap is null or p_sigma is null or p_sigma <= 0 then null
  when p_gap <= 0 then 0
  else least(99, greatest(0, round(100 * (1 - power(0.35, p_gap / p_sigma)))))::int end $f$;

-- Human selection text for every market (alerts, cards, X captions).
create or replace function public.selection_label(p_market text, p_outcome text, p_line numeric, p_home text, p_away text)
returns text language sql immutable as
$f$ select case coalesce(p_market, 'h2h')
  when 'h2h' then case p_outcome when 'home' then p_home || ' to win' when 'away' then p_away || ' to win' else 'Draw' end
  when 'totals' then initcap(p_outcome) || ' ' || trim_scale(p_line)::text || ' goals'
  when 'btts' then 'Both teams to score: ' || case when p_outcome = 'btts_yes' then 'Yes' else 'No' end
  when 'dc' then case p_outcome when 'dc_1x' then p_home || ' or draw' when 'dc_x2' then p_away || ' or draw' else p_home || ' or ' || p_away end
  when 'dnb' then case p_outcome when 'dnb_home' then p_home else p_away end || ' (draw no bet)'
  when 'ah' then case p_outcome
      when 'ah_home' then p_home || ' ' || case when p_line > 0 then '+' else '' end || trim_scale(p_line)::text
      else p_away || ' ' || case when -p_line > 0 then '+' else '' end || trim_scale(-p_line)::text end
      || ' (Asian handicap)'
  when 'corners' then initcap(p_outcome) || ' ' || trim_scale(p_line)::text || ' corners'
  when 'bookings' then initcap(p_outcome) || ' ' || trim_scale(p_line)::text || ' cards'
  else p_outcome end $f$;

create or replace function public.publish_new_market_signals()
returns integer language plpgsql security definer
set search_path to 'public', 'pg_catalog'
as $f$
declare n int := 0;
begin
  with fx as (
    select m.id as match_id, m.kickoff_at,
           coalesce(public.price_max_age((extract(epoch from m.kickoff_at - now()) / 3600.0)::numeric), interval '15 minutes') as max_age
    from public.matches m
    where m.kickoff_at > now() + interval '10 minutes' and m.kickoff_at < now() + interval '48 hours'
      and coalesce(m.status, 'scheduled') in ('scheduled', 'NS', 'TBD')
  ),
  q as (  -- every fresh quote for the six markets, one shape
    select ol.match_id, fx.kickoff_at, ol.bookmaker, ol.market, ol.market_line, ol.home_odds, ol.draw_odds, ol.away_odds
    from public.odds_extra_latest ol join fx on fx.match_id = ol.match_id
    where ol.confirmed_at > now() - fx.max_age
    union all
    select ol.match_id, fx.kickoff_at, ol.bookmaker, ol.market, ol.market_line, ol.home_odds, ol.draw_odds, ol.away_odds
    from public.odds_latest ol join fx on fx.match_id = ol.match_id
    where ol.market = 'totals' and ol.confirmed_at > now() - fx.max_age
      and not public.odds_latest_is_frozen(ol.match_id, ol.bookmaker, ol.market, ol.market_line, ol.price_since)
  ),
  p3 as (
    select ol.match_id, public.shin_devig(array[ol.home_odds, ol.draw_odds, ol.away_odds]::float8[]) as p
    from public.odds_latest ol join fx on fx.match_id = ol.match_id
    where ol.bookmaker = 'pinnacle' and ol.market = 'h2h' and ol.confirmed_at > now() - fx.max_age
      and not public.odds_latest_is_frozen(ol.match_id, ol.bookmaker, ol.market, ol.market_line, ol.price_since)
  ),
  p2 as (
    select match_id, market, market_line, public.shin_devig(array[home_odds, away_odds]::float8[]) as p
    from q where bookmaker = 'pinnacle' and market in ('totals', 'ah', 'corners', 'cards')
  ),
  uk as (select * from q where bookmaker = any (public.prime_post_books())),
  legs as (
    select u.match_id, u.kickoff_at, 'dc'::text as market, null::numeric as line, s.sel, s.price, u.bookmaker, s.fair
    from uk u join p3 on p3.match_id = u.match_id and p3.p is not null
    cross join lateral (values ('dc_1x', u.home_odds, p3.p[1] + p3.p[2]), ('dc_12', u.draw_odds, p3.p[1] + p3.p[3]),
                               ('dc_x2', u.away_odds, p3.p[2] + p3.p[3])) s(sel, price, fair)
    where u.market = 'dc'
    union all
    select u.match_id, u.kickoff_at, 'dnb', null, s.sel, s.price, u.bookmaker, s.fair
    from uk u join p3 on p3.match_id = u.match_id and p3.p is not null
    cross join lateral (values ('dnb_home', u.home_odds, p3.p[1] / (p3.p[1] + p3.p[3])),
                               ('dnb_away', u.away_odds, p3.p[3] / (p3.p[1] + p3.p[3]))) s(sel, price, fair)
    where u.market = 'dnb'
    union all
    select u.match_id, u.kickoff_at, case u.market when 'cards' then 'bookings' else u.market end, u.market_line,
           s.sel, s.price, u.bookmaker, s.fair
    from uk u join p2 on p2.match_id = u.match_id and p2.market = u.market and p2.market_line = u.market_line and p2.p is not null
    cross join lateral (values (case when u.market = 'ah' then 'ah_home' else 'over' end, u.home_odds, p2.p[1]),
                               (case when u.market = 'ah' then 'ah_away' else 'under' end, u.away_odds, p2.p[2])) s(sel, price, fair)
    where u.market in ('totals', 'ah', 'corners', 'cards')
      and (u.market <> 'ah' or u.market_line * 2 = floor(u.market_line * 2))
      and (u.market <> 'totals' or (u.market_line * 2) % 2 = 1)
  ),
  agg as (  -- best UK price per selection, and the panel's best price for every selection
    select l.*, count(*) over w as books,
           row_number() over (partition by l.match_id, l.market, l.line, l.sel order by l.price desc, l.bookmaker) as rn
    from legs l where l.price > 1 and l.fair > 0 and l.fair < 1
    window w as (partition by l.match_id, l.market, l.line, l.sel)
  ),
  best as (select * from agg where rn = 1),
  vec as (  -- market_prob: de-vigged best UK vector (Shin two-way; DC proportional to sum 2)
    select b.*,
      case when b.market = 'dc' then
             (1 / b.price) / ((select sum(1 / b2.price) from best b2 where b2.match_id = b.match_id and b2.market = 'dc') / 2)
           else (select (public.shin_devig(array[
                    max(b2.price) filter (where b2.sel in ('over', 'ah_home', 'dnb_home')),
                    max(b2.price) filter (where b2.sel in ('under', 'ah_away', 'dnb_away'))]::float8[]))
                     [case when b.sel in ('over', 'ah_home', 'dnb_home') then 1 else 2 end]
                 from best b2 where b2.match_id = b.match_id and b2.market = b.market and b2.line is not distinct from b.line)
      end as market_prob,
      b.fair * b.price - 1 as edge
    from best b
  ),
  cand as (
    select v.*, row_number() over (partition by v.match_id, v.market,
                   case when v.sel in ('over', 'ah_home', 'dnb_home', 'dc_1x') then 1 else 2 end
                   order by v.edge desc) as pick
    from vec v
    where v.fair >= 0.30 and v.price <= 4.50 and v.books >= 2 and v.edge >= 0.02
      and v.market_prob > 0 and v.market_prob < 1
  ),
  scored as (
    select c.*, (c.fair - c.market_prob) as gap,
           public.mes_raw((c.fair - c.market_prob)::numeric, 0.03) as mxs_raw,
           public.mes_edge_efficiency(c.edge::numeric) as eff
    from cand c where c.pick = 1
  ),
  ins as (
    insert into public.value_signals (match_id, outcome, market, market_line, detected_at, detected_odds, detected_edge,
                                      bookmaker, kickoff_at, model_architecture, model_prob, market_prob, prob_gap,
                                      model_sigma, mxs, mxs_raw, mes_efficiency, mes_basis, mxs_band, gap_basis,
                                      phase, result, detection_count, last_seen_at, notes_src)
    select s.match_id, s.sel, s.market, s.line, now(), s.price, round(s.edge::numeric, 4), s.bookmaker, s.kickoff_at,
           'MARKET_ANCHORED', round(s.fair::numeric, 4), round(s.market_prob::numeric, 4), round(s.gap::numeric, 6),
           0.03, round(s.mxs_raw * s.eff)::int, s.mxs_raw, round(s.eff::numeric, 4), 'yield_calibrated',
           public.maxedge_band(round(s.mxs_raw * s.eff)::int), 'devigged',
           'prematch', 'pending', 1, now(), null
    from scored s
    where not exists (select 1 from public.value_signals v
                       where v.match_id = s.match_id and v.market = s.market and v.outcome = s.sel
                         and v.market_line is not distinct from s.line and v.model_architecture = 'MARKET_ANCHORED'
                         and v.result = 'pending')
    returning 1)
  select count(*) into n from ins;
  return n;
end $f$;

-- 20261016164711 new_markets_price_views_116b
-- One quote source for every market: odds_latest (h2h/totals/btts) plus
-- odds_extra_latest (dc/dnb/ah/corners/cards; cards is 'bookings' on value_signals).
create or replace view public.v_all_quotes_latest as
select match_id, bookmaker, market, market_line, home_odds, draw_odds, away_odds, confirmed_at, price_since, false as extra
from public.odds_latest
union all
select match_id, bookmaker, case market when 'cards' then 'bookings' else market end, market_line,
       home_odds, draw_odds, away_odds, confirmed_at, null::timestamptz, true
from public.odds_extra_latest;
revoke all on public.v_all_quotes_latest from anon, authenticated;

create or replace function public.quote_for(p_outcome text, p_home numeric, p_draw numeric, p_away numeric)
returns numeric language sql immutable as
$f$ select case
  when p_outcome in ('home', 'over', 'btts_yes', 'dc_1x', 'dnb_home', 'ah_home') then p_home
  when p_outcome in ('draw', 'dc_12') then p_draw
  else p_away end $f$;

create or replace view public.v_signal_price_check as
 WITH p AS (
   SELECT v.id, v.match_id, v.market, v.outcome, v.detected_edge, v.detected_odds, v.model_prob, v.mxs, v.kickoff_at,
     ( SELECT max(public.quote_for(v.outcome, ol.home_odds, ol.draw_odds, ol.away_odds))
         FROM public.v_all_quotes_latest ol
        WHERE ol.match_id = v.match_id AND ol.market = coalesce(v.market, 'h2h')
          AND NOT ol.market_line IS DISTINCT FROM v.market_line
          AND ol.bookmaker <> 'apifootball_live'
          AND ol.confirmed_at > (now() - COALESCE(price_max_age(EXTRACT(epoch FROM v.kickoff_at - now()) / 3600.0), '00:15:00'::interval))
          AND (ol.extra OR NOT odds_latest_is_frozen(ol.match_id, ol.bookmaker, ol.market, ol.market_line, ol.price_since))) AS best
   FROM value_signals v
   WHERE COALESCE(v.result, 'pending') = 'pending' AND v.kickoff_at > now()
     AND COALESCE(v.phase, 'prematch') = 'prematch' AND v.model_prob IS NOT NULL
 )
 SELECT id, match_id, market, outcome, detected_edge, detected_odds, model_prob, mxs, kickoff_at, best,
   CASE WHEN best IS NULL THEN NULL::numeric ELSE round(model_prob * best - 1::numeric, 4) END AS edge,
   CASE
     WHEN best IS NULL THEN 'stale'
     WHEN (model_prob * best - 1::numeric) <= 0::numeric THEN 'edge_gone'
     WHEN best < detected_odds AND (model_prob * best - 1::numeric) < (0.5 * COALESCE(detected_edge, 0::numeric)) THEN 'shrunk'
     ELSE 'live'
   END AS st
 FROM p;

create or replace view public.v_prime_alert_state as
select v.id as signal_id, v.match_id, v.market, v.market_line, v.outcome, v.rung,
       v.model_prob, v.mxs, v.kickoff_at,
       public.prime_floor_odds(v.model_prob) as floor_odds,
       q.bookmaker, q.odds, q.confirmed_at, q.price_since
from public.value_signals v
left join lateral (
  select x.* from (
    select ol.bookmaker, public.quote_for(v.outcome, ol.home_odds, ol.draw_odds, ol.away_odds) as odds,
           ol.confirmed_at, ol.price_since
    from public.v_all_quotes_latest ol
    where ol.match_id = v.match_id and ol.market = coalesce(v.market, 'h2h')
      and ol.market_line is not distinct from v.market_line
      and ol.bookmaker = any (public.prime_post_books())
      and ol.confirmed_at > now() - coalesce(public.price_max_age(extract(epoch from v.kickoff_at - now()) / 3600.0), interval '15 minutes')
      and (ol.extra or not public.odds_latest_is_frozen(ol.match_id, ol.bookmaker, ol.market, ol.market_line, ol.price_since))
  ) x
  where x.odds is not null
  order by (x.odds >= public.prime_floor_odds(v.model_prob)) desc, (x.bookmaker = 'betano') asc, x.odds desc
  limit 1
) q on true
where coalesce(v.result, 'pending') = 'pending'
  and coalesce(v.phase, 'prematch') = 'prematch'
  and v.kickoff_at > now()
  and v.model_prob is not null;
revoke all on public.v_prime_alert_state from anon, authenticated;
