-- 067_gate_requires_takeability.sql
--
-- TAKEABILITY IS A PRODUCT METRIC, SO IT IS A GATE CRITERION (Rev 3, R3.2).
--
-- `paper_trade_gate()` asked two questions — is the no-vig CLV above the bar,
-- and is it distinguishable from noise. Both are answered over whichever trades
-- happen to be in the table, and neither notices if the prices were never
-- available. `DIXON_COLES` totals is the case: 17.4% of its published prices
-- were at or below what a bettable book was actually showing, meaning FIVE IN
-- SIX published signals could not be placed. No CLV number computed on the
-- surviving sixth redeems that — it is a customer-facing defect, not a
-- measurement nuisance.
--
-- So the gate now asks three questions, and the third is the share of trades
-- whose price was real. Default 90%: `MARKET_ANCHORED` sits at 85.4%, which
-- makes 90 a stretch rather than a fantasy.
--
-- WHAT IT DOES NOT DO. It does not filter the sample. Excluding unplaceable
-- trades from the CLV average would be the same survivorship bias that produced
-- the retired +14.79% yield headline, pointed at a different column. A signal
-- nobody could place is a signal that failed, and it stays in the denominator.
-- The gate REPORTS both figures — CLV over everything, and CLV over the
-- takeable subset — and judges the takeable rate separately.
--
--     takeable_pct   the product question: could a subscriber place these
--     clv_pct        the honest headline: everything published, nothing dropped
--     clv_takeable   the diagnostic: did the placeable ones beat the close
--
-- R2.2's "remainder" is NOT reinstated. It mixes genuine line movement with the
-- mechanical raw-to-de-vigged conversion and is biased negative by
-- construction, so a model could fail on it while being fine.

begin;

drop function if exists public.paper_trade_gate(integer, numeric, numeric);

create or replace function public.paper_trade_gate(
  p_min_n integer default 300,
  p_min_clv numeric default 0.005,
  p_min_clv_zscore numeric default 2.0,
  p_min_takeable numeric default 0.90
)
returns table(model text, market text, settled integer,
              takeable_pct numeric, avg_clv_pct numeric, clv_takeable_pct numeric,
              clv_zscore numeric, yield_pct numeric, verdict text)
language sql
stable
set search_path to 'public', 'pg_catalog'
as $function$
  with t as (
    select pt.*,
           public.price_was_takeable(pt.match_id, pt.market, pt.market_line,
                                     pt.selection, pt.logged_at, pt.price_taken) as takeable
    from public.paper_trades pt
  ),
  s as (
    select t.model, t.market,
      count(*) filter (where t.result in ('win','loss')) as n,
      -- The headline: EVERYTHING published. Unplaceable trades stay in.
      avg(t.no_vig_clv) as clv,
      stddev(t.no_vig_clv)::numeric as clv_sd,
      count(t.no_vig_clv) as n_clv,
      -- The diagnostic: only the ones a subscriber could have placed.
      avg(t.no_vig_clv) filter (where t.takeable) as clv_takeable,
      count(*) filter (where t.takeable is not null) as n_checkable,
      count(*) filter (where t.takeable) as n_takeable,
      sum(t.pl_units) as pl
    from t group by t.model, t.market),
  z as (
    select s.*,
      s.clv / nullif(s.clv_sd / sqrt(nullif(s.n_clv, 0))::numeric, 0) as zscore,
      s.n_takeable::numeric / nullif(s.n_checkable, 0) as takeable_rate
    from s)
  select z.model, z.market, z.n::int,
    round(100 * z.takeable_rate, 1),
    round(100 * z.clv, 2),
    round(100 * z.clv_takeable, 2),
    round(z.zscore, 2),
    round(100 * z.pl / nullif(z.n, 0), 2),
    case
      when z.n < p_min_n
        then format('HOLD - %s settled, needs %s', z.n, p_min_n)
      when z.n_clv = 0
        then 'HOLD - no closing line on any settled trade, CLV unmeasurable'
      when z.n_checkable = 0
        then 'HOLD - takeability unmeasurable, no contemporaneous quotes'
      -- The product question comes FIRST. A model whose prices were not
      -- available does not get to argue about its CLV.
      when z.takeable_rate < p_min_takeable
        then format('FAIL - only %s%% of prices were takeable, needs %s%%',
                    round(100 * z.takeable_rate, 1), round(100 * p_min_takeable, 1))
      when z.clv < p_min_clv
        then format('FAIL - no-vig CLV %s%% below the %s%% bar', round(100 * z.clv, 2), round(100 * p_min_clv, 2))
      when z.zscore is null or z.zscore < p_min_clv_zscore
        then format('FAIL - CLV z %s below %s', coalesce(round(z.zscore, 2)::text, 'n/a'), p_min_clv_zscore)
      else 'PASS'
    end
  from z order by z.model, z.market;
$function$;

comment on function public.paper_trade_gate(integer, numeric, numeric, numeric) is
  'The publication gate. Three criteria: takeability rate (could a subscriber place these), no-vig CLV over EVERY published trade (unplaceable ones stay in the denominator - excluding them is survivorship bias), and its z. clv_takeable_pct is reported as a diagnostic and is never the pass condition. See migration 067.';

commit;
