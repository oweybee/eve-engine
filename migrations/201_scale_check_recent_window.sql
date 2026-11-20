-- 201: market_prob_scale_check reads the last 14 days, not all history.
--
-- The view graded every devigged value_signals row ever written, so a cohort
-- that went bad once kept the hourly scale-health-check red for ever. On
-- 20 Nov 2026 it had failed every scheduled run since mid-October on totals
-- alone (avg 0.909): 175 Dixon-Coles longshot totals signals (lines 0.5 / 5.5-7.5,
-- priced 5-29) written from 5 Oct, where the de-vig loads the margin onto the
-- long shot and market_prob x odds lands at 0.6-0.8. The writer is fixed in
-- lib/secondaryMarkets.js (no goals-model signal above 5.00); this lets the
-- check judge what the engine is writing NOW.
--
-- Measured before apply, last 14 days: every market in band (totals 0.9617,
-- h2h 0.9611, corners 0.9479 ...), zero rows above 1.00.
--
-- Unchanged: the predicate, the verdict text, security_invoker=on, the grants
-- (postgres and service_role only). Reverting is the same statement without
-- the detected_at line.

create or replace view public.market_prob_scale_check
with (security_invoker = on) as
 select coalesce(market, 'h2h'::text) as market,
    count(*) as scored_rows,
    round(avg(market_prob * detected_odds), 4) as avg_consistency,
    round(min(market_prob * detected_odds), 4) as min_consistency,
    round(max(market_prob * detected_odds), 4) as max_consistency,
    count(*) filter (where (market_prob * detected_odds) > (1::numeric + 0.00005 * detected_odds)) as rows_over_one,
        case
            when count(*) = 0 then 'GREEN — no scored rows'::text
            when count(*) filter (where (market_prob * detected_odds) > (1::numeric + 0.00005 * detected_odds)) > 0 then 'RED — a fair line beats the price it was taken from'::text
            when avg(market_prob * detected_odds) < 0.94 or avg(market_prob * detected_odds) > 0.99 then 'RED — outside the 0.94-0.99 residual-margin band'::text
            else 'GREEN'::text
        end as verdict
   from value_signals
  where gap_basis = 'devigged'::text and market_prob is not null and detected_odds is not null and detected_odds > 1::numeric
    and detected_at > now() - interval '14 days'
  group by (coalesce(market, 'h2h'::text));
