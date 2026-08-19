-- 070_paper_harness_audit.sql
--
-- `paper_trades` HAS NEVER HELD A ROW, AND IT IS THE VESSEL FOR THE ONLY
-- EVIDENCE PHASE 2 WILL PRODUCE. Four defects, audited before it is filled
-- rather than discovered in week three as "low emission volume".
--
-- ── R6.1 · The dedup index collapses every fixture into one row ─────────────
--
-- `paper_trades_dedup_idx` is UNIQUE on
--   (COALESCE(external_ref, ''), model, market, COALESCE(market_line, -1), selection)
-- and `external_ref` is nullable. With it null, COALESCE maps EVERY fixture to
-- the same key, so the whole table can hold roughly one row per
-- model x market x line x selection — 10 to 15 rows for all time against a
-- 300-trade gate. `match_id` cannot rescue it because `match_id` is not in the
-- index. Found by probe: the second insert of a three-fixture batch was
-- rejected.
--
-- A convention ("remember to set external_ref") is what produced the finding.
-- NOT NULL is the version that cannot be forgotten. The table is empty, so this
-- costs nothing now and is unavailable later.
--
-- ── R6.2 · Unmeasurable takeability left the denominator ────────────────────
--
-- Migration 067 counted `n_checkable = count(*) filter (where takeable is not
-- null)` and computed the rate over that. So a row whose price cannot be
-- verified — no contemporaneous quote from any bettable book — vanished from
-- the metric built to catch exactly that kind of price. 40% unmeasurable and
-- 60% at 95% reported 95%. The `n_checkable = 0` guard only fired when EVERY
-- row was unmeasurable.
--
-- That is the +14.79% survivorship pattern one level down: the evidence that
-- would lower the number is the evidence being dropped. An unverifiable price
-- is now counted as NOT takeable — if we cannot demonstrate it existed, it did
-- not — and coverage is surfaced as its own column so the two failure modes
-- stay distinguishable.
--
-- ── R6.3 · The z-score was not fixture-clustered ────────────────────────────
--
-- This is the one that sets the bar the cutover is gated on. `n_clv` counted
-- ROWS, so the standard error assumed every CLV observation was independent —
-- the same error that turned a published +8.57% into a clustered +14.80% at
-- z 0.98 on the yield side, now sitting inside the threshold Phase 2 passes or
-- fails on.
--
-- Measured on the live corpus, naive z against fixture-clustered z:
--
--     architecture      market   rows   fx   per-fx   naive   clustered  ratio
--     MARKET_CONSENSUS  h2h       172   71     2.42   -3.20      -1.27   2.52
--     API_PREDICTIVE    h2h       230  102     2.25   -8.60      -4.42   1.95
--     LAMBDA_MC         h2h       167   67     2.49   -9.51      -6.21   1.53
--     DIXON_COLES       totals    148   92     1.61   +2.93      +2.90   1.01
--     MARKET_ANCHORED   h2h       105   89     1.18   +7.62      +9.00   0.85
--     DIXON_COLES       btts       57   48     1.19   +2.64      +3.49   0.76
--
-- TWO THINGS THAT ARE NOT OBVIOUS. sqrt(rows per fixture) is NOT an upper
-- bound — MARKET_CONSENSUS inflates 2.52x against sqrt(2.42) = 1.56, because
-- averaging within a fixture changes the variance structure and not merely the
-- count. And clustering can make z LARGER: MARKET_ANCHORED emits ~1.18
-- selections per fixture, so averaging removes more noise than it removes
-- sample, and its z RISES to 9.00.
--
-- So there is no global correction factor to apply and no threshold adjustment
-- that would substitute for computing it. MXDC_V1 pricing several markets off
-- one lambda fit will cluster harder than anything in that table, which is
-- precisely why this must be right before Phase 1 rather than after Phase 2.
--
-- The POINT ESTIMATE is clustered too, not just the error bar — one CLV value
-- per fixture, then the mean across fixtures — matching what the performance
-- summary already does for yield. Reporting a per-row mean beside a clustered
-- z would be two units in one row.
--
-- ── R6.4 · avg(no_vig_clv) over ALL rows is CORRECT ─────────────────────────
--
-- Not a defect; recorded so nobody "fixes" it. CLV needs a CLOSE, not a RESULT.
-- A trade with a closing line but no settled result still has a valid CLV and
-- belongs in the average; filtering to settled would discard measurable
-- evidence for no reason. Only `n` (the sample-size gate) and `yield_pct`
-- require a result, and both filter for it explicitly.
--
-- ── Also noted, and NOT fixed here ──────────────────────────────────────────
--
-- `CHECK (model_prob > 0 AND model_prob < 1)` is strictly exclusive, so a
-- Dixon-Coles pricing a deep tail can round to 0 or 1 and RAISE. The constraint
-- is right — a probability of exactly 0 or 1 is not one — so the fix belongs in
-- the writer: MXDC_V1 must clamp to (0,1) before insert. Left as a Phase 1
-- build requirement rather than silently widened, because a harness that
-- accepts a degenerate probability is worse than one that refuses it loudly.

begin;

-- ── R6.1 ────────────────────────────────────────────────────────────────────
-- Empty table, so this is free now and impossible later.
alter table public.paper_trades alter column external_ref set not null;

comment on column public.paper_trades.external_ref is
  'REQUIRED. Part of paper_trades_dedup_idx, which COALESCEs it to the empty string — leave it null and every fixture collapses to one key, capping the table at ~10-15 rows for all time. Set it per fixture (the match UUID or the feed fixture id). See migration 070.';

-- ── R6.2 + R6.3 ─────────────────────────────────────────────────────────────
drop function if exists public.paper_trade_gate(integer, numeric, numeric, numeric);

create or replace function public.paper_trade_gate(
  p_min_n integer default 300,
  p_min_clv numeric default 0.005,
  p_min_clv_zscore numeric default 2.0,
  -- PROVISIONAL, per migration 069: null means not yet thresholded.
  p_min_takeable numeric default null,
  -- Likewise unset. A takeability rate computed over a third of the sample is
  -- not a takeability rate, but the floor must come from an observed
  -- distribution rather than from a number chosen here.
  p_min_coverage numeric default null
)
returns table(model text, market text, settled integer, settled_fixtures integer,
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
           -- UNVERIFIABLE IS NOT TAKEABLE. If we cannot show the price existed,
           -- it did not; dropping these is how the metric would hide the very
           -- prices it exists to catch.
           coalesce(r.verdict_raw, false) as takeable,
           (r.verdict_raw is not null)    as checkable
    from r
  ),
  -- ONE CLV OBSERVATION PER FIXTURE. The unit of independence is the match:
  -- several markets priced off one lambda fit share ninety minutes.
  fx as (
    select model, market, match_id, avg(no_vig_clv) as fv
    from t where no_vig_clv is not null
    group by 1, 2, 3
  ),
  cl as (
    select model, market,
           count(*)::int as n_fx,
           avg(fv) as mu,
           stddev(fv)::numeric as sd
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
      s.n_checkable::numeric / nullif(s.n_total, 0) as coverage_rate
    from s join cl on cl.model = s.model and cl.market = s.market
  )
  select z.model, z.market, z.n, z.n_fx,
    round(100 * z.takeable_rate, 1),
    round(100 * z.coverage_rate, 1),
    round(100 * z.mu, 2),
    round(100 * z.clv_takeable, 2),
    round(z.zscore, 2),
    round(100 * z.pl / nullif(z.n, 0), 2),
    case
      when z.n < p_min_n
        then format('HOLD - %s settled, needs %s', z.n, p_min_n)
      when z.n_clv = 0
        then 'HOLD - no closing line on any settled trade, CLV unmeasurable'
      -- ZERO COVERAGE IS DEGENERATE, NOT A THRESHOLD. A takeability rate over
      -- no measurable rows is not a rate, so this holds unconditionally — the
      -- same class of guard as `n_clv = 0`, and NOT a bar anyone chose. Keeping
      -- only the parameterised floor below would let a model with nothing
      -- verifiable return PASS while `p_min_coverage` is unset, which is worse
      -- than the guard migration 067 had.
      when z.n_checkable = 0
        then 'HOLD - takeability unmeasurable on every trade, no contemporaneous quotes'
      when p_min_coverage is not null and z.coverage_rate < p_min_coverage
        then format('HOLD - takeability measurable on only %s%% of trades, needs %s%%',
                    round(100 * z.coverage_rate, 1), round(100 * p_min_coverage, 1))
      when p_min_takeable is not null and z.takeable_rate < p_min_takeable
        then format('FAIL - only %s%% of prices were takeable, needs %s%%',
                    round(100 * z.takeable_rate, 1), round(100 * p_min_takeable, 1))
      when z.mu < p_min_clv
        then format('FAIL - clustered no-vig CLV %s%% below the %s%% bar',
                    round(100 * z.mu, 2), round(100 * p_min_clv, 2))
      when z.zscore is null or z.zscore < p_min_clv_zscore
        then format('FAIL - clustered CLV z %s below %s',
                    coalesce(round(z.zscore, 2)::text, 'n/a'), p_min_clv_zscore)
      when p_min_takeable is null
        then format('PASS (takeability %s%% over %s%% coverage - not yet thresholded)',
                    round(100 * z.takeable_rate, 1), round(100 * z.coverage_rate, 1))
      else 'PASS'
    end
  from z order by z.model, z.market;
$function$;

comment on function public.paper_trade_gate(integer, numeric, numeric, numeric, numeric) is
  'The publication gate. CLV and its z are FIXTURE-CLUSTERED - one observation per match before the mean and the standard error - because several markets priced off one lambda fit share ninety minutes. Unverifiable takeability counts as NOT takeable and coverage is reported separately. Takeability and coverage thresholds are PROVISIONAL (null = not yet thresholded, set from post-fix data). CLV averages every trade with a closing line, settled or not: CLV needs a close, not a result. See migrations 067, 069, 070.';

commit;
