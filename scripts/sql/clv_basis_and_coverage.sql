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
                  and cl.selection = f.outcome) as close_at_this_selection,
       -- A line quoted more than closing_line_max_lead_minutes() (180) before
       -- kickoff is NOT a close (migration 113): settle and the 087 repair both
       -- read closing_lines_valid, so a row that is true on the column above
       -- and false here has a benchmark that will never attach. That is 8 of
       -- the 11 PRIME rows without CLV on 15 Sep 2026.
       exists (select 1 from public.closing_lines_valid cl
                where cl.match_id = f.match_id and cl.market = f.market
                  and cl.market_line is not distinct from f.market_line
                  and cl.selection = f.outcome) as close_is_valid
  from fi f
 where f.no_vig_clv is null
 order by f.kickoff_at desc;

-- READING IT. `close_is_valid = true` with a null CLV is the settle-time
-- attach having missed (eve-engine 063 attaches at settle with no fallback;
-- `attach_missing_closing_lines()` from 087 is the repair, and /admin has a
-- button for it). `close_at_this_selection = true` with `close_is_valid =
-- false` is a line captured too far ahead of kickoff to count as a close —
-- a capture-cadence gap, not an attach gap. `any_close_for_match = false` is
-- capture-closing-lines.yml not covering the league or the market.
--
-- MEASURED 15 Sep 2026, after 127 and one run of the repair, over the 727
-- settled published signals since the epoch:
--     with a de-vigged CLV            593
--     no CLV, line too early           100   (lead 183–413 min on the PRIME ones)
--     no CLV, no line for the match     34
--   PRIME first-detection rows: 54 · 43 with CLV · 8 too early · 3 no line
--   EDGE  first-detection rows: 27 · 20 with CLV · 4 too early · 3 no line
