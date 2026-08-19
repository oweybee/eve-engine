-- 069_takeability_threshold_provisional.sql
--
-- THE 90% TAKEABILITY BAR WAS CALIBRATED AGAINST AN ARTIFACT. UNSET IT.
--
-- Migration 067 added takeability as a gate criterion and defaulted it to 0.90,
-- reasoning that MARKET_ANCHORED's observed 85.4% made 90 "a stretch rather
-- than a fantasy". That reasoning is void. 85.4% was measured while
-- `ingestOdds` was fetching every planned fixture on every run — the bug fixed
-- in the same branch — so `computeConsensus`'s "latest quote per book" was
-- genuinely fresh. It is the FAVOURABLE case, produced by polling no post-fix
-- configuration will reproduce.
--
-- Setting a threshold from it is the same mistake as the hand-copied sigma
-- constants and the PRIME cutoff: a number derived from a broken measurement,
-- frozen into a rule, and then defended because it is written down.
--
-- Takeability also has a volatility gradient that argues the post-fix
-- distribution will be lower, not higher. Measured by detection lead:
--
--     architecture       <=2h     2-6h    6-24h     >24h
--     MARKET_ANCHORED   78.9%    87.5%    78.1%    96.7%
--     DIXON_COLES       38.2%    41.7%    53.3%    62.5%
--
-- Prices move 0.51x/hour inside T-2h against 0.11x/hour a day out, so a
-- recorded price near kickoff is beaten sooner and fails takeability more
-- often. Post-fix, every window moves from maximal polling to tier-governed
-- polling; the closing floor mitigates the worst of it and cannot beat it.
--
-- SO THE THRESHOLD IS NULL — unset, not zero. The criterion keeps its PLACE in
-- the gate: asked FIRST, before CLV, over an unfiltered sample. Only its VALUE
-- waits for a week of post-fix data across lead-time buckets.
--
-- A PASS MUST SAY SO. With no threshold, an otherwise-passing model returns
-- 'PASS (takeability not yet thresholded)' rather than a bare PASS, because a
-- silent pass would let a criterion nobody has set read as a criterion
-- something has met. `takeable_pct` is reported either way — the measurement
-- was never the part in doubt.
--
-- `paper_trades` is empty, so this changes no existing verdict.

begin;

drop function if exists public.paper_trade_gate(integer, numeric, numeric, numeric);

create or replace function public.paper_trade_gate(
  p_min_n integer default 300,
  p_min_clv numeric default 0.005,
  p_min_clv_zscore numeric default 2.0,
  -- PROVISIONAL: null means "not yet thresholded". Set it from the observed
  -- post-fix distribution, never from a figure measured before the ingest fix.
  p_min_takeable numeric default null
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
      -- The product question comes FIRST, when there is a bar to ask it against.
      when p_min_takeable is not null and z.takeable_rate < p_min_takeable
        then format('FAIL - only %s%% of prices were takeable, needs %s%%',
                    round(100 * z.takeable_rate, 1), round(100 * p_min_takeable, 1))
      when z.clv < p_min_clv
        then format('FAIL - no-vig CLV %s%% below the %s%% bar', round(100 * z.clv, 2), round(100 * p_min_clv, 2))
      when z.zscore is null or z.zscore < p_min_clv_zscore
        then format('FAIL - CLV z %s below %s', coalesce(round(z.zscore, 2)::text, 'n/a'), p_min_clv_zscore)
      -- A pass with no takeability bar must not read as having cleared one.
      when p_min_takeable is null
        then format('PASS (takeability %s%% - not yet thresholded)', round(100 * z.takeable_rate, 1))
      else 'PASS'
    end
  from z order by z.model, z.market;
$function$;

comment on function public.paper_trade_gate(integer, numeric, numeric, numeric) is
  'The publication gate. Takeability is asked FIRST but its threshold is PROVISIONAL and defaults to null - the 90% in migration 067 was calibrated against 85.4% measured through the ingest bug, i.e. under maximal polling that no post-fix configuration reproduces. Set it from a week of post-fix data. CLV is averaged over EVERY published trade; unplaceable ones stay in the denominator. See migration 069.';

commit;
