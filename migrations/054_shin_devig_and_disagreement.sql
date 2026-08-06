-- 054_shin_devig_and_disagreement.sql
--
-- Two things the market-anchored architecture (ruling of 6 Aug 2026) needs in
-- the database rather than in Node:
--
--   1. shin_devig()               — the de-vig, callable from SQL.
--   2. disagreement_calibration   — the model-vs-market scorecard, materialised
--                                   so UI copy is generated from data.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 1. shin_devig()
--
-- A THIRD port of lib/devig.js, and the reason for it is not convenience. The
-- scorecard below is an aggregate over 44,000+ selections and the refresh has to
-- run in-database; shipping 44,000 rows to Node to divide them and ship them
-- back is a worse design than one immutable function. It is verified against the
-- SAME golden vectors as engine.devig.test.js — themselves produced by an
-- independent mpmath implementation — and agreement was confirmed to 1e-12
-- across all four vectors before this migration was written.
--
-- If you retune the de-vig, retune lib/devig.js, eve-frontend/lib/devig.ts and
-- this function together. There is no shared package between these repos; the
-- alternative to three synchronised copies is each surface deciding for itself,
-- which is what produced the failure this whole architecture exists to stop.
--
-- WHY SHIN. Proportional de-vig assumes books spread margin evenly across
-- outcomes. They do not — they load it onto outsiders. Measured on this corpus,
-- proportional de-vig flags 637 selections at 8.00+ where Shin flags 203, and
-- the 8.00+ band returns -22.0% under proportional against -7.8% under Shin.
-- The margin structure is the whole difference.

create or replace function shin_devig(odds double precision[])
returns double precision[]
language plpgsql
immutable
parallel safe
set search_path = ''
as $fn$
declare
  n    int := array_length(odds, 1);
  pim  double precision[] := '{}';   -- implied probabilities, 1/odds
  outp double precision[] := '{}';
  bigp double precision := 0;        -- the overround, Σ 1/odds
  lo   double precision := 0;
  hi   double precision := 1 - 1e-12;
  z    double precision := 0;        -- Shin's insider fraction
  s    double precision;
  tot  double precision := 0;
  i int; k int;
begin
  -- A market is de-vigged as a COMPLETE set or not at all. De-vigging two legs
  -- of a three-way book normalises the pair to 1, prices the missing leg at
  -- zero, and reports enormous edge on both survivors. NULL in, NULL out.
  if n is null or n < 2 then return null; end if;

  for k in 1..n loop
    if odds[k] is null or odds[k] <= 1 or odds[k] = 'Infinity'::double precision
       or odds[k] = 'NaN'::double precision then
      return null;
    end if;
    pim[k] := 1.0 / odds[k];
    bigp := bigp + pim[k];
  end loop;

  -- No margin to remove: the book is fair, or the prices are collectively
  -- beatable (an "arb", which on this platform's feeds has always been a stale
  -- or mispulled leg rather than a real one). Shin has no positive z to find,
  -- so normalise. Callers that care about the distinction should check the
  -- overround themselves — this function returns probabilities, not warnings.
  if bigp <= 1 + 1e-12 then
    for k in 1..n loop outp[k] := pim[k] / bigp; end loop;
    return outp;
  end if;

  -- Σ p_i(z) is monotonically decreasing in z on [0,1): at z=0 it equals the
  -- overround (>1), and it falls through 1 as z rises. Bisection is therefore
  -- safe, and on a bounded interval to 1e-10 it is fast enough for a function
  -- that runs once per market.
  for i in 1..200 loop
    z := (lo + hi) / 2;
    s := 0;
    for k in 1..n loop
      s := s + (sqrt(z*z + 4*(1-z)*(pim[k]*pim[k])/bigp) - z) / (2*(1-z));
    end loop;
    exit when abs(s - 1) < 1e-10 or (hi - lo) < 1e-10;
    if s > 1 then lo := z; else hi := z; end if;
  end loop;

  for k in 1..n loop
    outp[k] := (sqrt(z*z + 4*(1-z)*(pim[k]*pim[k])/bigp) - z) / (2*(1-z));
    tot := tot + outp[k];
  end loop;
  -- Bisection lands the sum within 1e-10 of 1, not exactly on it. Every caller
  -- is entitled to assume a probability vector sums to 1.
  for k in 1..n loop outp[k] := outp[k] / tot; end loop;

  return outp;
end
$fn$;

comment on function shin_devig(double precision[]) is
  'Shin (1992) de-vig. Returns true probabilities summing to 1, or NULL if the market is incomplete. Mirrors eve-engine/lib/devig.js and eve-frontend/lib/devig.ts — keep all three in step.';


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. disagreement_calibration
--
-- The model-vs-market scorecard, materialised.
--
-- WHY IT IS A TABLE AND NOT A CONSTANT IN A COMPONENT. Every number shown to a
-- subscriber must come from a query or a materialised table. A scorecard
-- hardcoded into UI copy is a claim that was true when someone typed it and
-- becomes a lie the first time the model is re-fit, silently, with nobody
-- reading the string again.
--
-- WHAT IT MEASURES. For every 1X2 selection in research_dc_preds: the model's
-- probability against Shin-de-vigged Pinnacle CLOSING, bucketed by how far
-- apart they are. "Right" is whichever probability sat closer to the realised
-- 0/1 outcome. The gradient it records is the reason the model does not get a
-- vote: as the model diverges from the market, the MARKET wins more often —
-- 48.5% of the time when they agree, 65.1% when they are 15pp apart. The
-- model's disagreement is not information, it is anti-information.
--
-- THE ROWS ARE IN-SAMPLE. research_dc_preds is fitted per season (fit_label
-- dc_2019 … dc_2025), so the model is being graded on matches it was fitted on
-- and these figures FLATTER it. The true out-of-sample gradient is at least
-- this steep. That is a caveat on the model's defence, never on the market's.

create table if not exists disagreement_calibration (
  gap_bucket        text primary key,
  gap_min           numeric not null,
  gap_max           numeric,             -- null on the open-ended top bucket
  n                 int     not null,
  market_right_pct  numeric not null,
  model_right_pct   numeric not null,
  brier_model       numeric not null,
  brier_market      numeric not null,
  computed_at       timestamptz not null default now()
);

comment on table disagreement_calibration is
  'Model-vs-market scorecard by disagreement size. Populated by refresh_disagreement_calibration(). The source of every disagreement figure shown in the UI — nothing here may be hardcoded into copy.';

-- Aggregates stay real at every tier: this is a summary of 44,000 settled
-- historical selections and reveals no fixture, price or claim. It is reference
-- data, so anon reads it.
alter table disagreement_calibration enable row level security;

drop policy if exists disagreement_calibration_read on disagreement_calibration;
create policy disagreement_calibration_read
  on disagreement_calibration for select
  to anon, authenticated
  using (true);

-- Writes are the refresh function's alone. No table-level insert/update grant:
-- migration 045 was needed precisely because a blanket grant let members write
-- columns that were meant to be server-only.
revoke insert, update, delete on disagreement_calibration from anon, authenticated;


-- ─────────────────────────────────────────────────────────────────────────────
-- refresh_disagreement_calibration()
--
-- Recompute the whole scorecard from research_dc_preds. Runnable on demand and
-- REQUIRED after any model re-fit — the numbers describe a specific fit, and a
-- re-fit that does not refresh this table leaves the UI quoting the old model's
-- record as though it were the new one's.
--
-- SECURITY DEFINER so it can write a table nobody else may write, with
-- search_path pinned.

create or replace function refresh_disagreement_calibration()
returns int
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  rows_written int;
begin
  with base as (
    select
      ftr, p_home, p_draw, p_away,
      (odds->>'PSCH')::double precision ch,
      (odds->>'PSCD')::double precision cd,
      (odds->>'PSCA')::double precision ca
    from public.research_dc_preds
    where (odds->>'PSCH')::double precision > 1
      and (odds->>'PSCD')::double precision > 1
      and (odds->>'PSCA')::double precision > 1
      and ftr in ('H','D','A')
      and p_home is not null and p_draw is not null and p_away is not null
  ),
  fair as (
    select ftr, p_home, p_draw, p_away, public.shin_devig(array[ch, cd, ca]) sh
    from base
  ),
  sel as (
    -- One row per SELECTION, not per match: the scorecard is about how often a
    -- probability was closer to the truth, and each of home/draw/away is its
    -- own such claim.
    select v.mp model_p, v.mkt, (case when f.ftr = v.pick then 1 else 0 end)::double precision y
    from fair f,
    lateral (values
      ('H', f.p_home::double precision, f.sh[1]),
      ('D', f.p_draw::double precision, f.sh[2]),
      ('A', f.p_away::double precision, f.sh[3])
    ) v(pick, mp, mkt)
    where f.sh is not null
  ),
  bucketed as (
    select *, abs(model_p - mkt) gap from sel
  ),
  labelled as (
    select
      case
        when gap < 0.03 then '<3pp'
        when gap < 0.06 then '3-6pp'
        when gap < 0.10 then '6-10pp'
        when gap < 0.15 then '10-15pp'
        else '15pp+'
      end as gap_bucket,
      case
        when gap < 0.03 then 0.00 when gap < 0.06 then 0.03
        when gap < 0.10 then 0.06 when gap < 0.15 then 0.10 else 0.15
      end as gap_min,
      case
        when gap < 0.03 then 0.03 when gap < 0.06 then 0.06
        when gap < 0.10 then 0.10 when gap < 0.15 then 0.15 else null
      end as gap_max,
      model_p, mkt, y
    from bucketed
  ),
  agg as (
    select
      gap_bucket, gap_min, gap_max,
      count(*)::int n,
      -- "Right" = strictly closer to the realised outcome. Exact ties count for
      -- neither, so the two percentages need not sum to 100 — and must not be
      -- presented as though they do.
      round(100.0 * count(*) filter (where power(mkt - y, 2) < power(model_p - y, 2))::numeric / count(*), 1) market_right_pct,
      round(100.0 * count(*) filter (where power(model_p - y, 2) < power(mkt - y, 2))::numeric / count(*), 1) model_right_pct,
      round(avg(power(model_p - y, 2))::numeric, 4) brier_model,
      round(avg(power(mkt - y, 2))::numeric, 4) brier_market
    from labelled
    group by gap_bucket, gap_min, gap_max
  )
  -- Schema-qualified: search_path is pinned to '' on this function, so an
  -- unqualified target does not resolve.
  insert into public.disagreement_calibration
    (gap_bucket, gap_min, gap_max, n, market_right_pct, model_right_pct, brier_model, brier_market, computed_at)
  select gap_bucket, gap_min, gap_max, n, market_right_pct, model_right_pct, brier_model, brier_market, now()
  from agg
  on conflict (gap_bucket) do update set
    gap_min          = excluded.gap_min,
    gap_max          = excluded.gap_max,
    n                = excluded.n,
    market_right_pct = excluded.market_right_pct,
    model_right_pct  = excluded.model_right_pct,
    brier_model      = excluded.brier_model,
    brier_market     = excluded.brier_market,
    computed_at      = excluded.computed_at;

  get diagnostics rows_written = row_count;
  return rows_written;
end
$fn$;

comment on function refresh_disagreement_calibration() is
  'Recompute disagreement_calibration from research_dc_preds vs Shin-de-vigged Pinnacle closing. Run on demand and after EVERY model re-fit.';

revoke execute on function refresh_disagreement_calibration() from anon, authenticated;

select refresh_disagreement_calibration();
