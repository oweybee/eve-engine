-- Read-only. Run in the Supabase SQL editor. Nothing here writes.
--
-- The two measurements the 15 Sep 2026 brief asked for (§4a and §4c),
-- written in the RECORD's own operators — `< odds_max`, `result in
-- ('win','loss')`, `coalesce(market_line, -1)` — rather than the brief's
-- approximations (`between 1.40 and 3.00`, `result is not null`, a bare
-- `market_line`), so the numbers match `performance_band` rather than a
-- nearby cohort. Migration 127 prints the same §4a comparison as NOTICEs at
-- apply time; this file is for re-running it afterwards.

-- ── §4a: the CLV a band reads under each basis ─────────────────────────────
with band as (
  -- change to 'edge' for the EDGE box; both boxes come from the table
  select edge_min, edge_max, odds_min, odds_max
    from public.performance_band where band_key = 'prime'
),
q as (
  select v.*
    from public.value_signals v
    join public.model_calibration mc
      on mc.model_architecture = v.model_architecture and mc.publish
    cross join band b
   where v.detected_at >= public.performance_epoch()
     and v.result in ('win','loss')
     and v.detected_edge >= b.edge_min and v.detected_edge < b.edge_max
     and v.detected_odds >= b.odds_min and v.detected_odds < b.odds_max
),
hi as (
  select distinct on (match_id, market, coalesce(market_line, -1), outcome) *
    from q order by match_id, market, coalesce(market_line, -1), outcome, detected_odds desc, detected_at
),
fi as (
  select distinct on (match_id, market, coalesce(market_line, -1), outcome) *
    from q order by match_id, market, coalesce(market_line, -1), outcome, detected_at
)
select 'highest_price'   as basis, count(*) as bets, round(avg(no_vig_clv) * 100, 2) as clv_pct, count(no_vig_clv) as clv_n from hi
union all
select 'first_detection',          count(*),         round(avg(no_vig_clv) * 100, 2),            count(no_vig_clv)          from fi;

-- ── §4c: PRIME rows with no CLV, and whether a close exists for the fixture ─
with band as (
  select edge_min, edge_max, odds_min, odds_max
    from public.performance_band where band_key = 'prime'
),
q as (
  select v.*
    from public.value_signals v
    join public.model_calibration mc
      on mc.model_architecture = v.model_architecture and mc.publish
    cross join band b
   where v.detected_at >= public.performance_epoch()
     and v.result in ('win','loss')
     and v.detected_edge >= b.edge_min and v.detected_edge < b.edge_max
     and v.detected_odds >= b.odds_min and v.detected_odds < b.odds_max
),
fi as (
  select distinct on (match_id, market, coalesce(market_line, -1), outcome) *
    from q order by match_id, market, coalesce(market_line, -1), outcome, detected_at
)
select f.match_id, f.market, f.market_line, f.outcome, f.bookmaker, f.kickoff_at,
       exists (select 1 from public.closing_lines cl where cl.match_id = f.match_id) as any_close_for_match,
       exists (select 1 from public.closing_lines cl
                where cl.match_id = f.match_id and cl.market = f.market
                  and cl.market_line is not distinct from f.market_line
                  and cl.selection = f.outcome) as close_at_this_selection
  from fi f
 where f.no_vig_clv is null
 order by f.kickoff_at desc;

-- READING IT. `any_close_for_match = true` with a null CLV is the settle-time
-- attach having missed (eve-engine 063 attaches at settle with no fallback;
-- `attach_missing_closing_lines()` from 087 is the repair, and /admin has a
-- button for it). `false` is capture-closing-lines.yml not covering the league
-- or the market. The second column separates "a close for the fixture" from
-- "a close for THIS selection", which the brief's query did not.
