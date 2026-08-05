-- 048_close_ends_at_kickoff.sql
--
-- STAGED, NOT APPLIED. Data repair — run once, after the engine fixes in this
-- change are deployed (captureSnapshot skipping post-kickoff matches, the
-- apifootball_live exclusion, and the pre-kickoff bound in prefetchClosingOdds).
-- Applying it before them would clean history the very next tick re-pollutes.
--
-- PROBLEM. Two leaks let in-play prices into the pre-match record:
--
--   1. captureSnapshot treated any snapshot up to 3 HOURS AFTER kickoff as
--      'closing', and kept snapshotting matches for as long as their
--      computed_values row survived — days, once the pipeline stalled. The
--      market tracker charts drew these post-kickoff points as pre-match
--      history (the "10,423% move" to 201.00 on Universitatea Cluj v Botosani
--      was a live price two hours into the match), and the CLV backfill graded
--      recommendations against them.
--
--   2. Its depth query read every bookmaker in `odds`, including
--      'apifootball_live' — the synthetic book the in-play ingester writes
--      live prices under. A live long-shot then becomes the series' "best"
--      price among fifteen pre-match books quoting ~1.9.
--
-- CLV's entire meaning is "the price we recommended vs where the market
-- CLOSED" — the last pre-kickoff price. A post-kickoff comparison point does
-- not degrade the metric, it inverts it: in-play prices move on goals, so the
-- polluted rows are exactly the extreme ones.
--
-- WHAT THIS DOES.
--   A. Deletes odds_snapshots rows from 'apifootball_live'.
--   B. Deletes odds_snapshots rows captured after their match's kickoff.
--   C. Re-grades recommendations.closing_odds / clv_pct from the best
--      remaining pre-kickoff closing-window snapshot; NULLs the pair where no
--      genuine close survives (NULL means "close not captured", never "0%").
--   D. Same repair for pre-match value_signals (clv = ln(detected/closing)).
--
-- All four statements are idempotent; re-running is a no-op.

begin;

-- A. In-play prices have no place in the pre-match snapshot series.
delete from odds_snapshots
where bookmaker = 'apifootball_live';

-- B. The pre-match series ends at kickoff.
delete from odds_snapshots os
using matches m
where m.id = os.match_id
  and m.kickoff_at is not null
  and os.captured_at > m.kickoff_at;

-- C. Re-grade recommendations against the surviving genuine close: the best
-- price across books in the last pre-kickoff closing-window capture.
with true_close as (
  select distinct on (os.match_id, os.selection)
         os.match_id, os.selection, os.hour_bucket
  from odds_snapshots os
  join matches m on m.id = os.match_id
  where os.market_type = 'h2h'
    and os.snapshot_type = 'closing'
    and os.captured_at <= m.kickoff_at
  order by os.match_id, os.selection, os.captured_at desc
),
best_close as (
  select os.match_id, os.selection, max(os.odds) as odds
  from odds_snapshots os
  join true_close tc
    on tc.match_id = os.match_id
   and tc.selection = os.selection
   and tc.hour_bucket = os.hour_bucket
  where os.market_type = 'h2h' and os.snapshot_type = 'closing'
  group by os.match_id, os.selection
)
update recommendations r
set closing_odds = bc.odds,
    clv_pct      = round(((r.recommended_odds - bc.odds) / bc.odds * 100)::numeric, 2)
from best_close bc
where bc.match_id  = r.match_id
  and bc.selection = r.selection
  and r.closing_odds is not null
  and bc.odds > 1;

-- ...and where no genuine close survives, the honest value is NULL.
update recommendations r
set closing_odds = null, clv_pct = null
where r.closing_odds is not null
  and not exists (
    select 1
    from odds_snapshots os
    join matches m on m.id = os.match_id
    where os.match_id = r.match_id
      and os.selection = r.selection
      and os.market_type = 'h2h'
      and os.snapshot_type = 'closing'
      and os.captured_at <= m.kickoff_at
  );

-- D. Pre-match value_signals: same idea, log-CLV formula (fetchResults.js).
-- In-play signals are untouched — their clv is already NULL by design.
with true_close as (
  select distinct on (os.match_id, os.selection)
         os.match_id, os.selection, os.hour_bucket
  from odds_snapshots os
  join matches m on m.id = os.match_id
  where os.market_type = 'h2h'
    and os.snapshot_type = 'closing'
    and os.captured_at <= m.kickoff_at
  order by os.match_id, os.selection, os.captured_at desc
),
best_close as (
  select os.match_id, os.selection, max(os.odds) as odds
  from odds_snapshots os
  join true_close tc
    on tc.match_id = os.match_id
   and tc.selection = os.selection
   and tc.hour_bucket = os.hour_bucket
  where os.market_type = 'h2h' and os.snapshot_type = 'closing'
  group by os.match_id, os.selection
)
update value_signals vs
set closing_odds = bc.odds,
    clv          = round(ln(vs.detected_odds / bc.odds)::numeric, 4)
from best_close bc
where bc.match_id  = vs.match_id
  and bc.selection = vs.outcome
  and vs.outcome in ('home', 'draw', 'away')
  and coalesce(vs.phase, 'prematch') <> 'inplay'
  and vs.closing_odds is not null
  and bc.odds > 1
  and vs.detected_odds > 1;

update value_signals vs
set closing_odds = null, clv = null
where vs.outcome in ('home', 'draw', 'away')
  and coalesce(vs.phase, 'prematch') <> 'inplay'
  and vs.closing_odds is not null
  and not exists (
    select 1
    from odds_snapshots os
    join matches m on m.id = os.match_id
    where os.match_id = vs.match_id
      and os.selection = vs.outcome
      and os.market_type = 'h2h'
      and os.snapshot_type = 'closing'
      and os.captured_at <= m.kickoff_at
  );

commit;
