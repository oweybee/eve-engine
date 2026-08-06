-- 048_maxedge_score.sql
--
-- STAGED, NOT APPLIED. This is the first of four migrations that land the
-- 2026-08-05 model audit. Apply them in order, in a branch first:
--
--     048  model_calibration + maxedge_score() + board_signals   (this file)
--     049  the outcome dimension and coverage penalty
--     050  the paper-trade harness
--     051  the multi-league prediction writer that feeds it
--
-- 049 seeds model_calibration_outcome by cross-joining model_calibration, so
-- 048 must be applied first or 049 seeds nothing and every outcome silently
-- falls back to a 1.0 multiplier it never wrote down. 050 and 051 are
-- independent of both, but 051 reads mx_team_form, which 050's bring-up
-- sequence does not create — 051 creates it.
--
-- WHAT THIS DOES, IN ONE LINE. Replaces the Kelly-fraction MES with a score
-- anchored on measured calibration error, and gates the board on a per-model
-- `publish` flag rather than on the score. The audit found that three of the
-- five "models" are not models: API_PREDICTIVE emits five distinct
-- probabilities keyed to price bands, MARKET_CONSENSUS reproduces the de-vigged
-- market price (Brier 0.3051 against the market's 0.3050), and inplay_baseline
-- is consensus odds recombined through a Poisson. The seeded `publish` column
-- turns those off. Expect the board to get much shorter.
--
-- SCHEMA VERIFIED against production (project zlbmpeiuhyllxwegtayu) on
-- 2026-08-05, before staging. Every column this file reads exists:
--   value_signals — model_prob, market_prob (both numeric(6,4), migration 039),
--   detected_odds, detected_edge, model_architecture (025), market, market_line
--   (026), bookmaker, outcome, result, kickoff_at, clv (006).
-- The four columns it ADDS — prob_gap, model_sigma, mxs, mxs_band — do not
-- exist yet, so the `add column if not exists` block is a real write.
--
-- ONE KNOWN INTERACTION, not a defect but worth knowing before you apply.
-- Migration 026's dedup index coalesces a NULL model_architecture to
-- 'MARKET_CONSENSUS'; the joins here coalesce it to ''. A legacy row with no
-- architecture therefore matches no calibration row, gets no sigma, no MXS, and
-- never reaches board_signals. That is the safe direction — MARKET_CONSENSUS is
-- seeded publish=false anyway, so those rows would be excluded either way — but
-- it means `mxs is null` after the backfill is not by itself evidence of a bug.
--
-- The 353 settled signals the sigma seeds were measured on are all that exist.
-- refresh_model_calibration() holds at n < 150 by default for exactly that
-- reason, and it is read-only unless you pass p_apply => true.

-- ============================================================================
-- MaxEdge — MaxEdgeScore (MXS) migration
-- 2026-08-05
--
-- Replaces the Kelly-fraction-based MES with a calibration-anchored score.
--
--   z   = (p_model - p_market) / sigma_p        signal-to-noise of the edge
--   MXS = 100 * (1 - 0.35 ^ (z / z_gate))      65 == the selection boundary
--
-- Two properties worth knowing before you read the rest:
--   1. MXS = 65 exactly when z = z_gate. So "PRIME" and "MXS >= 65" are the
--      same fact and cannot disagree on a card.
--   2. sigma_p is MEASURED per model (calibration error), not chosen. It
--      replaces the old trust multipliers, which were applied after the
--      compression and therefore hard-capped three architectures.
--
-- NOTHING here is applied automatically. Review, then run in a branch first.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Per-model calibration
-- ---------------------------------------------------------------------------

create table if not exists public.model_calibration (
  model_architecture text primary key,
  sigma_p            numeric      not null check (sigma_p > 0),
  sigma_source       text         not null default 'default',   -- measured | floor | default
  z_gate             numeric      not null default 1.0 check (z_gate > 0),
  n_settled          integer      not null default 0,
  publish            boolean      not null default false,
  notes              text,
  calibrated_at      timestamptz  not null default now()
);

comment on table public.model_calibration is
  'Measured probability error (sigma_p, in probability units) per model architecture. '
  'Feeds maxedge_score(). Replaces the old post-hoc trust multipliers. '
  'sigma_source=floor means the measurement resolved to ~0 and the floor is being used '
  'because volume is too low to resolve smaller errors.';

comment on column public.model_calibration.publish is
  'False = signals from this architecture are scored but never surfaced as value. '
  'Gate the board on this, not on the score.';

-- Seeded from the 2026-08-05 audit of 353 settled value_signals.
insert into public.model_calibration
  (model_architecture, sigma_p, sigma_source, z_gate, n_settled, publish, notes)
values
  ('DIXON_COLES',      0.0300, 'floor',    1.0,  77, true,
   'Measured sigma 0.00pp: every calibration bin inside its own 95% noise band at n=77. '
   'Cannot resolve below ~3-4pp at this volume, so 3.00pp is a conservative floor. '
   'Yield +7.6%, CLV -0.44%, Brier 0.4903 vs market 0.4937 (beats the market).'),

  ('MARKET_CONSENSUS', 0.0693, 'measured', 1.0, 193, false,
   'NOT A MODEL: root Brier 0.3051 vs market 0.3050 - adds zero information. '
   'The 10-20% bin is 108 bets claiming 15.1% that won 3.7% (noise band +/-6.7pp), '
   'i.e. provable miscalibration. Yield -47.0%, CLV -24.9%, avg odds 7.02. '
   'This is a best-price finder, not an edge finder. Relabel or retire.'),

  ('API_PREDICTIVE',   0.0530, 'measured', 1.0,  53, false,
   'NOT A MODEL: emits exactly 5 distinct probabilities (45/35/33/30/10%), all whole '
   'percentages, each mapped to a tight odds band - a step function of the price. '
   '45% is applied to home, draw AND away alike. Edge is an artifact of where a price '
   'sits inside its bucket. Brier 0.4660 vs market 0.4655 (loses to the market). '
   'Fix the upstream source or retire; do not publish.'),

  ('CORNERS_MODEL',    0.0600, 'default',  1.0,   4, false,
   'Insufficient settled sample (n=4). Default sigma. Hold until n >= 30.'),

  ('CARDS_MODEL',      0.0600, 'default',  1.0,   2, false,
   'Insufficient settled sample (n=2). Default sigma. Hold until n >= 30.')
on conflict (model_architecture) do update
  set sigma_p       = excluded.sigma_p,
      sigma_source  = excluded.sigma_source,
      z_gate        = excluded.z_gate,
      n_settled     = excluded.n_settled,
      publish       = excluded.publish,
      notes         = excluded.notes,
      calibrated_at = now();

alter table public.model_calibration enable row level security;

drop policy if exists model_calibration_read on public.model_calibration;
create policy model_calibration_read on public.model_calibration
  for select using (true);

-- ---------------------------------------------------------------------------
-- 2. The score
-- ---------------------------------------------------------------------------

create or replace function public.maxedge_score(
  p_gap    numeric,          -- p_model - p_market, in probability units (0.03 = 3pp)
  p_sigma  numeric,          -- model's measured probability error
  p_z_gate numeric default 1.0
) returns integer
language sql immutable parallel safe as $$
  select case
    when p_gap is null or p_sigma is null or p_sigma <= 0 or p_z_gate <= 0 then null
    when p_gap <= 0 then 0
    else least(99, greatest(0,
      round(100 * (1 - power(0.35, p_gap / (p_sigma * p_z_gate))))
    ))::int
  end;
$$;

comment on function public.maxedge_score is
  'MXS = 100 * (1 - 0.35 ^ (gap / (sigma * z_gate))). Returns 0-99; 100 is unreachable '
  'by design (would require infinite certainty). By construction MXS = 65 exactly when '
  'gap = sigma * z_gate, so 65 IS the selection boundary. Treat MXS > 92 as a '
  'data-integrity alert (stale price / mismapped selection), not a green light.';

create or replace function public.maxedge_band(p_mxs integer)
returns text language sql immutable parallel safe as $$
  select case
    when p_mxs is null then null
    when p_mxs >= 65 then 'PRIME'      -- backed
    when p_mxs >= 40 then 'WATCH'      -- not backed
    when p_mxs >= 25 then 'NOTED'      -- not backed
    else                  'NOISE'      -- inside our own error bars
  end;
$$;

comment on function public.maxedge_band is
  'Only PRIME is backed. Deliberately avoids calling an unbacked reading "Strong" - '
  'that reads as a recommendation you have declined to make. Keep the label strings '
  'in sync with LABELS in lib/signalTier.js.';

-- ---------------------------------------------------------------------------
-- 3. Store the inputs and the verdict at detection time
--    (so changing the methodology never retroactively rewrites the ledger)
-- ---------------------------------------------------------------------------

alter table public.value_signals
  add column if not exists prob_gap    numeric,
  add column if not exists model_sigma numeric,
  add column if not exists mxs         integer,
  add column if not exists mxs_band    text;

comment on column public.value_signals.prob_gap is
  'p_model - p_market at detection, in probability units. This is the quantity the '
  'score is built on and the one to show on the card instead of EV edge %.';
comment on column public.value_signals.model_sigma is
  'sigma_p in force when this signal was scored. Frozen so history stays auditable.';
comment on column public.value_signals.mxs is
  'MaxEdgeScore frozen at detection. Never recompute for settled rows.';

-- ---------------------------------------------------------------------------
-- 4. Backfill
--    model_prob / market_prob have been NULL on all rows since inception.
--    Both are recoverable exactly from detected_edge and detected_odds:
--      p_market = 1 / odds
--      p_model  = (1 + edge) / odds
-- ---------------------------------------------------------------------------

update public.value_signals
set model_prob  = coalesce(model_prob,  (1 + detected_edge) / detected_odds),
    market_prob = coalesce(market_prob, 1 / detected_odds)
where detected_odds is not null
  and detected_edge is not null
  and detected_odds > 0;

update public.value_signals
set prob_gap = model_prob - market_prob
where model_prob is not null
  and market_prob is not null
  and prob_gap is null;

update public.value_signals vs
set model_sigma = mc.sigma_p,
    mxs         = public.maxedge_score(vs.prob_gap, mc.sigma_p, mc.z_gate),
    mxs_band    = public.maxedge_band(
                    public.maxedge_score(vs.prob_gap, mc.sigma_p, mc.z_gate))
from public.model_calibration mc
where coalesce(vs.model_architecture, '') = mc.model_architecture
  and vs.prob_gap is not null
  and vs.mxs is null;

create index if not exists value_signals_mxs_idx
  on public.value_signals (mxs desc nulls last, kickoff_at);

-- ---------------------------------------------------------------------------
-- 5. The board
--    Gated on publish, ordered by MXS. Emits prob_gap so the UI can show
--    "29.0% -> 33.0%" rather than an EV percentage that fights the score.
-- ---------------------------------------------------------------------------

create or replace view public.board_signals as
select
  vs.id,
  vs.match_id,
  vs.kickoff_at,
  vs.outcome,
  vs.market,
  vs.market_line,
  vs.detected_odds        as price,
  vs.bookmaker,
  round(vs.market_prob * 100, 1) as market_pct,
  round(vs.model_prob  * 100, 1) as model_pct,
  round(vs.prob_gap    * 100, 1) as gap_pp,
  vs.mxs,
  vs.mxs_band,
  vs.model_architecture,
  -- fractional-Kelly stake, in units. Separate axis from the score on purpose:
  -- the score says how sure we are, the stake says how much that is worth.
  round(
    least(5.0,
      greatest(0,
        (vs.detected_edge / nullif(vs.detected_odds - 1, 0))
        * (0.03 / nullif(vs.model_sigma, 0))   -- shrink by relative model quality
        * 25
      )
    ), 1
  ) as stake_units,
  vs.mxs > 92 as needs_price_check
from public.value_signals vs
join public.model_calibration mc
  on mc.model_architecture = coalesce(vs.model_architecture, '')
where mc.publish
  and vs.result = 'pending'
  and vs.kickoff_at > now()
  and vs.mxs is not null
order by vs.mxs desc, vs.kickoff_at;

comment on view public.board_signals is
  'Homepage board. Gated on model_calibration.publish - which currently excludes '
  'MARKET_CONSENSUS (56% of historical volume, -47% yield) and API_PREDICTIVE. '
  'Expect the board to get much shorter and much better.';

-- ---------------------------------------------------------------------------
-- 6. Recalibration (run weekly; writes evidence, never auto-applies)
--
--    Estimator: bin by p_model, take the weighted RMS of (observed - predicted),
--    then SUBTRACT the binomial sampling variance. Without that subtraction you
--    measure your own sample noise and conclude every model is broken.
--
--      sigma^2 = mean_w(gap^2) - mean_w(p(1-p)/n)
--
--    Floors at 3pp: below that the estimate is not resolvable at MaxEdge volume.
-- ---------------------------------------------------------------------------

create or replace function public.refresh_model_calibration(
  p_min_n integer default 150,
  p_floor numeric default 0.03,
  p_apply boolean default false
) returns table (
  model_architecture text,
  n_settled          integer,
  bins               integer,
  sigma_measured     numeric,
  sigma_recommended  numeric,
  sigma_current      numeric,
  action             text
)
language plpgsql as $$
begin
  return query
  with base as (
    select coalesce(vs.model_architecture, '') as arch,
           vs.model_prob as p,
           case when vs.result = 'win' then 1.0 else 0.0 end as won
    from public.value_signals vs
    where vs.result in ('win', 'loss')
      and vs.model_prob is not null
  ), binned as (
    select arch,
           count(*)   as n,
           avg(p)     as p_bar,
           avg(won)   as obs
    from base
    group by arch, width_bucket(p, 0, 1, 10)
    having count(*) >= 5
  ), agg as (
    select arch,
           sum(n)::int   as n_used,
           count(*)::int as n_bins,
           sqrt(greatest(0,
             sum(n * power(obs - p_bar, 2)) / sum(n)
             - sum(p_bar * (1 - p_bar)) / sum(n)
           ))::numeric   as sigma_hat
    from binned
    group by arch
  )
  select a.arch,
         a.n_used,
         a.n_bins,
         round(a.sigma_hat, 4),
         round(greatest(a.sigma_hat, p_floor), 4),
         mc.sigma_p,
         case
           when a.n_used < p_min_n then
             format('HOLD - only %s settled, need %s', a.n_used, p_min_n)
           when a.sigma_hat <= p_floor then
             format('FLOOR - measured %s pp is below the %s pp resolution limit',
                    round(a.sigma_hat * 100, 2), round(p_floor * 100, 2))
           when abs(a.sigma_hat - mc.sigma_p) < 0.005 then
             'NO CHANGE'
           else
             format('REVIEW - measured %s pp vs current %s pp',
                    round(a.sigma_hat * 100, 2), round(mc.sigma_p * 100, 2))
         end
  from agg a
  left join public.model_calibration mc
    on mc.model_architecture = a.arch
  order by a.n_used desc;

  if p_apply then
    update public.model_calibration mc
    set sigma_p = sub.sigma_new,
        sigma_source = case when sub.sigma_hat <= p_floor then 'floor' else 'measured' end,
        n_settled = sub.n_used,
        calibrated_at = now()
    from (
      with base as (
        select coalesce(vs.model_architecture, '') as arch,
               vs.model_prob as p,
               case when vs.result = 'win' then 1.0 else 0.0 end as won
        from public.value_signals vs
        where vs.result in ('win','loss') and vs.model_prob is not null
      ), binned as (
        select arch, count(*) as n, avg(p) as p_bar, avg(won) as obs
        from base group by arch, width_bucket(p, 0, 1, 10) having count(*) >= 5
      )
      select arch,
             sum(n)::int as n_used,
             sqrt(greatest(0, sum(n * power(obs - p_bar, 2)) / sum(n)
                              - sum(p_bar * (1 - p_bar)) / sum(n)))::numeric as sigma_hat,
             greatest(
               sqrt(greatest(0, sum(n * power(obs - p_bar, 2)) / sum(n)
                                - sum(p_bar * (1 - p_bar)) / sum(n)))::numeric,
               p_floor
             ) as sigma_new
      from binned group by arch
    ) sub
    where mc.model_architecture = sub.arch
      and sub.n_used >= p_min_n;
  end if;
end;
$$;

comment on function public.refresh_model_calibration is
  'Weekly recalibration. Read-only by default - pass p_apply => true to write. '
  'Never wire this to a cron with p_apply => true until you have watched a few '
  'runs and agree with what it wants to change.';

commit;

-- ============================================================================
-- Verification (run after committing)
-- ============================================================================
--
-- What the current board becomes:
--   select * from public.board_signals;
--
-- Did the score sort by profitability, out of sample:
--   select mxs_band,
--          count(*) n,
--          round(avg(detected_odds), 2) avg_odds,
--          round(100.0 * count(*) filter (where result = 'win') / count(*), 1) strike,
--          round(100.0 * sum(case when result = 'win' then detected_odds - 1 else -1 end)
--                / count(*), 1) yield_pct
--   from public.value_signals
--   where result in ('win','loss') and mxs_band is not null
--   group by 1 order by 1;
--
-- Recalibration dry run:
--   select * from public.refresh_model_calibration();
--
-- Sanity-check the score's anchor (all three must return 65):
--   select public.maxedge_score(0.03, 0.03, 1.0),
--          public.maxedge_score(0.0693, 0.0693, 1.0),
--          public.maxedge_score(0.06, 0.03, 2.0);
-- ============================================================================
