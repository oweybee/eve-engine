-- 071_gate_sample_size_is_powered.sql
--
-- THE SAMPLE GATE COUNTS FIXTURES, AND THE BAR IS DERIVED FROM THE MODEL'S OWN
-- VARIANCE RATHER THAN CHOSEN.
--
-- Migration 070 clustered the CLV estimator by fixture but left `p_min_n`
-- counting ROWS, so "300 settled" meant 300 rows — 100 fixtures for a model
-- pricing three markets off one lambda fit. The estimator and the sample gate
-- were in different units.
--
-- A FLAT BAR IS THE WRONG INSTRUMENT. Fixture-clustered CLV standard deviation
-- tracks the odds profile hard, so one number is simultaneously too strict for
-- a short-odds anchored book and far too lax for a longshot one. Measured:
--
--     architecture       market   fixtures    sd    fixtures for +1.0% @ 80%
--     MARKET_ANCHORED    h2h            89   3.64%                      105
--     DIXON_COLES        totals         92   3.77%                      112
--     DIXON_COLES        btts           48   3.94%                      122
--     LAMBDA_MC          h2h            67   4.51%                      160
--     API_PREDICTIVE     h2h           102   6.17%                      299
--     MARKET_CONSENSUS   h2h            71  11.05%                      960
--
-- A single 300 would certify MARKET_CONSENSUS on under a third of the sample
-- its own noise demands. That is the failure the +92.7% longshot bucket already
-- exploited once: a wide-variance book flattering a short record.
--
-- THE RULE
--
--     required_fixtures = max(150, ceil((2.802 * sd_hi / 0.010)^2))
--
-- 2.802 is z(0.975) + z(0.80) = 1.9600 + 0.8416, the two-sided 5% test at 80%
-- power. 0.010 is the effect it must be able to detect: a +1.0% clustered
-- no-vig CLV, about the smallest edge worth acting on after costs.
--
-- `sd_hi` IS THE UPPER BOUND OF A 90% ONE-SIDED CI ON THE SD, not the point
-- estimate, and that closes the circularity: a model whose sd came out low by
-- luck would otherwise lower its own bar. Normal approximation to the sampling
-- distribution of s:
--
--     sd_hi = sd * (1 + 1.6449 / sqrt(2 * (n_fx - 1)))
--
-- It costs nothing in the regime that matters — MARKET_ANCHORED goes 105 -> 132
-- and DIXON_COLES totals 112 -> 141, both still under the floor — and bites
-- exactly where the sd is untrustworthy: MARKET_CONSENSUS 960 -> 1,245.
--
-- THE 150 FLOOR is the one chosen number, and it is chosen as a floor rather
-- than a target: no model gets certified on a sample that small however tight
-- its variance looks, because a sd estimated from a short run is the thing
-- least worth trusting. On the profile MXDC_V1 should have, the floor binds and
-- the formula never fires — roughly 25% more wall-clock than the ~120-fixture
-- equivalent of the old bar, not a new phase.
--
-- THE Z TEST IS NOT REDUNDANT WITH THIS. The power calculation sets the minimum
-- sample at which the test COULD detect +1.0%; the z threshold is the test
-- itself. A model can clear the sample bar and still fail on z, which is the
-- intended shape — having enough evidence and having favourable evidence are
-- different questions.
--
-- SIGNATURE NOTE: the first parameter is now a FIXTURE floor, not a row count.
-- The plan's A5 call `paper_trade_gate(300, 0.0, 2.0)` still resolves and now
-- means 300 FIXTURES. Every verdict string names the unit so the change cannot
-- be misread from the output.

begin;

drop function if exists public.paper_trade_gate(integer, numeric, numeric, numeric, numeric);

create or replace function public.paper_trade_gate(
  p_min_fixtures integer default 150,
  p_min_clv numeric default 0.005,
  p_min_clv_zscore numeric default 2.0,
  p_min_takeable numeric default null,
  p_min_coverage numeric default null,
  -- The effect the sample must be powered to detect: +1.0% clustered no-vig CLV.
  p_detect numeric default 0.010
)
returns table(model text, market text, settled integer, settled_fixtures integer,
              required_fixtures integer, clustered_sd_pct numeric,
              takeable_pct numeric, coverage_pct numeric,
              avg_clv_pct numeric, clv_takeable_pct numeric,
              clv_zscore numeric, yield_pct numeric, verdict text)
language sql
stable
set search_path to 'public', 'pg_catalog'
as $function$
  with r as (
    select pt.*,
           public.price_was_takeable(pt.match_id, pt.market, pt.market_line,
                                     pt.selection, pt.logged_at, pt.price_taken) as verdict_raw
    from public.paper_trades pt
  ),
  t as (
    select r.*,
           coalesce(r.verdict_raw, false) as takeable,
           (r.verdict_raw is not null)    as checkable
    from r
  ),
  fx as (
    select model, market, match_id, avg(no_vig_clv) as fv
    from t where no_vig_clv is not null
    group by 1, 2, 3
  ),
  cl as (
    select model, market, count(*)::int as n_fx, avg(fv) as mu, stddev(fv)::numeric as sd
    from fx group by 1, 2
  ),
  s as (
    select t.model, t.market,
      count(*) filter (where t.result in ('win','loss'))::int as n,
      count(*)::int                                           as n_total,
      count(*) filter (where t.checkable)::int                as n_checkable,
      count(*) filter (where t.takeable)::int                 as n_takeable,
      count(t.no_vig_clv)::int                                as n_clv,
      avg(t.no_vig_clv) filter (where t.takeable)             as clv_takeable,
      sum(t.pl_units)                                         as pl
    from t group by 1, 2
  ),
  z as (
    select s.*, cl.n_fx, cl.mu, cl.sd,
      cl.mu / nullif(cl.sd / sqrt(nullif(cl.n_fx, 0))::numeric, 0) as zscore,
      s.n_takeable::numeric  / nullif(s.n_total, 0) as takeable_rate,
      s.n_checkable::numeric / nullif(s.n_total, 0) as coverage_rate,
      -- Upper bound of a 90% one-sided CI on the sd. Null below 2 fixtures,
      -- where there is no sd to bound and the floor governs alone.
      case when cl.n_fx >= 2 and cl.sd is not null
           then cl.sd * (1 + (1.6449 / sqrt(2 * (cl.n_fx - 1)))::numeric) end as sd_hi
    from s join cl on cl.model = s.model and cl.market = s.market
  ),
  g as (
    select z.*,
      greatest(
        p_min_fixtures,
        coalesce(ceil(power(2.802 * z.sd_hi / nullif(p_detect, 0), 2))::int, p_min_fixtures)
      ) as req_fx
    from z
  )
  select g.model, g.market, g.n, g.n_fx, g.req_fx,
    round(100 * g.sd, 2),
    round(100 * g.takeable_rate, 1),
    round(100 * g.coverage_rate, 1),
    round(100 * g.mu, 2),
    round(100 * g.clv_takeable, 2),
    round(g.zscore, 2),
    round(100 * g.pl / nullif(g.n, 0), 2),
    case
      -- FIXTURES, not rows, and the requirement is the model's own.
      when g.n_fx < g.req_fx
        then format('HOLD - %s settled fixtures, needs %s (powered for +%s%% at sd %s%%)',
                    g.n_fx, g.req_fx, round(100 * p_detect, 1),
                    coalesce(round(100 * g.sd, 2)::text, 'n/a'))
      when g.n_clv = 0
        then 'HOLD - no closing line on any settled trade, CLV unmeasurable'
      -- Degenerate, not a threshold: a rate over no measurable rows is not a rate.
      when g.n_checkable = 0
        then 'HOLD - takeability unmeasurable on every trade, no contemporaneous quotes'
      when p_min_coverage is not null and g.coverage_rate < p_min_coverage
        then format('HOLD - takeability measurable on only %s%% of trades, needs %s%%',
                    round(100 * g.coverage_rate, 1), round(100 * p_min_coverage, 1))
      when p_min_takeable is not null and g.takeable_rate < p_min_takeable
        then format('FAIL - only %s%% of prices were takeable, needs %s%%',
                    round(100 * g.takeable_rate, 1), round(100 * p_min_takeable, 1))
      when g.mu < p_min_clv
        then format('FAIL - clustered no-vig CLV %s%% below the %s%% bar',
                    round(100 * g.mu, 2), round(100 * p_min_clv, 2))
      when g.zscore is null or g.zscore < p_min_clv_zscore
        then format('FAIL - clustered CLV z %s below %s',
                    coalesce(round(g.zscore, 2)::text, 'n/a'), p_min_clv_zscore)
      when p_min_takeable is null
        then format('PASS (takeability %s%% over %s%% coverage - not yet thresholded)',
                    round(100 * g.takeable_rate, 1), round(100 * g.coverage_rate, 1))
      else 'PASS'
    end
  from g order by g.model, g.market;
$function$;

comment on function public.paper_trade_gate(integer, numeric, numeric, numeric, numeric, numeric) is
  'The publication gate. Sample size counts FIXTURES, not rows, and the bar is DERIVED: max(150, ceil((2.802*sd_hi/0.010)^2)) where sd_hi is the 90% CI upper bound on the model own fixture-clustered CLV sd - so a wide-variance longshot book must show far more evidence than a short-odds anchored one, and a luckily-low sd cannot lower its own bar. CLV and z are fixture-clustered. Unverifiable takeability counts as NOT takeable; zero coverage holds unconditionally. Takeability and coverage thresholds remain PROVISIONAL. See migrations 067, 069, 070, 071.';

commit;
