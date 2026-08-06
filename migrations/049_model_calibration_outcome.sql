-- 049_model_calibration_outcome.sql
--
-- STAGED, NOT APPLIED. Apply after 048 — the seed rows here are built by
-- cross-joining model_calibration, so on an empty parent table this migration
-- succeeds and inserts nothing, and effective_sigma() then returns NULL for
-- every architecture (the join is a LEFT JOIN on the outcome table but an INNER
-- lookup on model_calibration, so a missing parent row means no sigma at all).
-- Check `select count(*) from model_calibration_outcome` is 25 after applying:
-- 5 architectures x (3 h2h + 2 totals + 2 btts) outcomes.
--
-- WHAT IT ADDS. sigma stops being one number per model and becomes a product of
-- three measured terms — model x coverage x outcome. The coverage term is the
-- one that matters most here: coverage_penalty() returns NULL below 30 prior
-- matches, and that NULL is designed to propagate through effective_sigma() to
-- a NULL score and no published signal. Refusing to emit is the whole point.
-- Falling back to whatever was available is how API_PREDICTIVE ended up
-- publishing a five-value lookup table against fixtures it had never seen —
-- 191 teams published on, 164 in the training data, zero overlap.
--
-- The away-win question is settled in the file and settled by measurement: over
-- 17,078 English-league matches, blind-backing at the best closing price
-- returns home -0.24%, draw -3.56%, away -0.52%. The draw is the mispriced
-- outcome, not the away win. So every multiplier seeds at 1.0 and only
-- refresh_outcome_calibration() moves it, at n >= 100 per cell.
--
-- SCHEMA VERIFIED against production 2026-08-05: value_signals.clv exists
-- (migration 006, numeric(6,4)), and market/outcome carry the vocabularies
-- migration 026 constrained them to. Note that the outcome CHECK on
-- model_calibration_outcome admits 'yes'/'no' for btts while value_signals
-- constrains btts outcomes to 'btts_yes'/'btts_no' — so a btts cell will never
-- be matched by refresh_outcome_calibration()'s join and will sit at its 1.0
-- default forever. Harmless today (no btts architecture is published) but it is
-- a real gap the moment one is; fix it in the same pass that publishes btts.

-- ============================================================================
-- MaxEdge — add the outcome dimension to model calibration
-- 2026-08-05 (follow-up to 20260805_maxedge_score.sql)
--
-- Rationale, from 17,078 English-league matches over 7 seasons, blind-backing
-- every outcome at the BEST closing price across the market:
--
--     home  -0.24%      draw  -3.56%      away  -0.52%
--
-- Away wins are priced about as efficiently as home wins. The draw is the
-- badly-priced outcome, by a factor of 3-7. So there is no case for excluding
-- away wins by rule -- but there IS a case for letting each outcome carry its
-- own measured error, because a team-strength model's failure modes differ by
-- outcome (they habitually over-rate away underdogs by under-weighting home
-- advantage and match context).
--
-- So: sigma becomes a product of three measured terms rather than one.
--
--     sigma_eff = sigma_model x coverage_penalty(sample) x outcome_penalty
--
-- All three are measured from settled results. None is chosen.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Outcome-level calibration, measured not assumed
-- ---------------------------------------------------------------------------

create table if not exists public.model_calibration_outcome (
  model_architecture text    not null,
  market             text    not null default 'h2h',
  outcome            text    not null check (outcome in ('home','draw','away','over','under','yes','no')),
  sigma_multiplier   numeric not null default 1.0 check (sigma_multiplier > 0),
  n_settled          integer not null default 0,
  measured_clv       numeric,
  measured_yield     numeric,
  source             text    not null default 'default',   -- measured | default
  notes              text,
  calibrated_at      timestamptz not null default now(),
  primary key (model_architecture, market, outcome)
);

comment on table public.model_calibration_outcome is
  'Per-outcome sigma multiplier. 1.0 = no adjustment. >1 widens sigma so that '
  'outcome needs a bigger disagreement to reach the same score. Starts at 1.0 '
  'everywhere: we adjust on evidence, never on hunch. Populate from '
  'refresh_outcome_calibration() once n_settled >= 100 per cell.';

comment on column public.model_calibration_outcome.sigma_multiplier is
  'Measured. Do NOT hand-edit to express a view about an outcome type -- that is '
  'how the trust multipliers went wrong. Let refresh_outcome_calibration() set it.';

-- Everything starts neutral. Away wins are NOT penalised out of the gate.
insert into public.model_calibration_outcome
  (model_architecture, market, outcome, sigma_multiplier, source, notes)
select mc.model_architecture, m.market, o.outcome, 1.0, 'default',
       'Neutral until n_settled >= 100. Blind-price ROI on English leagues 2019-2026: '
       'home -0.24%, draw -3.56%, away -0.52% -- no prior justifies penalising away.'
from public.model_calibration mc
cross join (values ('h2h')) as m(market)
cross join (values ('home'),('draw'),('away')) as o(outcome)
on conflict do nothing;

insert into public.model_calibration_outcome
  (model_architecture, market, outcome, sigma_multiplier, source, notes)
select mc.model_architecture, m.market, o.outcome, 1.0, 'default', 'Neutral until measured.'
from public.model_calibration mc
cross join (values ('totals')) as m(market)
cross join (values ('over'),('under')) as o(outcome)
on conflict do nothing;

insert into public.model_calibration_outcome
  (model_architecture, market, outcome, sigma_multiplier, source, notes)
select mc.model_architecture, m.market, o.outcome, 1.0, 'default', 'Neutral until measured.'
from public.model_calibration mc
cross join (values ('btts')) as m(market)
cross join (values ('yes'),('no')) as o(outcome)
on conflict do nothing;

alter table public.model_calibration_outcome enable row level security;
drop policy if exists model_calibration_outcome_read on public.model_calibration_outcome;
create policy model_calibration_outcome_read on public.model_calibration_outcome
  for select using (true);

-- ---------------------------------------------------------------------------
-- 2. Coverage penalty -- how much history do we actually have on these teams?
--    This is what "prioritise the leagues I have data for" becomes in practice:
--    not a filter, a sigma term. Zero history produces NO signal.
-- ---------------------------------------------------------------------------

create or replace function public.coverage_penalty(p_team_matches integer)
returns numeric language sql immutable parallel safe as $$
  select case
    when p_team_matches is null or p_team_matches < 30 then null   -- no signal at all
    when p_team_matches >= 400 then 1.00
    when p_team_matches >= 200 then 1.15
    when p_team_matches >= 100 then 1.35
    else                            1.70
  end;
$$;

comment on function public.coverage_penalty is
  'Widens sigma when we hold little history on the teams involved. NULL below 30 '
  'matches -- meaning refuse to emit a signal rather than fall back to something. '
  'Falling back is exactly how API_PREDICTIVE ended up publishing a 5-value lookup '
  'table for Andorran qualifiers.';

-- ---------------------------------------------------------------------------
-- 3. Effective sigma: model x coverage x outcome, all measured
-- ---------------------------------------------------------------------------

create or replace function public.effective_sigma(
  p_architecture  text,
  p_market        text,
  p_outcome       text,
  p_team_matches  integer
) returns numeric
language sql stable parallel safe as $$
  select mc.sigma_p
       * public.coverage_penalty(p_team_matches)
       * coalesce(mco.sigma_multiplier, 1.0)
  from public.model_calibration mc
  left join public.model_calibration_outcome mco
    on  mco.model_architecture = mc.model_architecture
    and mco.market  = p_market
    and mco.outcome = p_outcome
  where mc.model_architecture = p_architecture;
$$;

comment on function public.effective_sigma is
  'The single sigma that feeds maxedge_score(). Returns NULL when coverage is '
  'insufficient, which must propagate to a NULL score and no published signal.';

-- ---------------------------------------------------------------------------
-- 4. Measure the outcome multipliers from settled results
--    Read-only unless p_apply. Requires 100 settled per cell before it will
--    touch anything -- below that you are measuring noise, per Winkelmann et al.
--    (77.63% chance of a spurious "significant" season under full efficiency).
-- ---------------------------------------------------------------------------

create or replace function public.refresh_outcome_calibration(
  p_min_n  integer default 100,
  p_apply  boolean default false
) returns table (
  model_architecture text,
  market             text,
  outcome            text,
  n_settled          integer,
  strike_pct         numeric,
  yield_pct          numeric,
  avg_clv_pct        numeric,
  current_multiplier numeric,
  suggested_multiplier numeric,
  action             text
)
language plpgsql as $$
begin
  return query
  with s as (
    select coalesce(vs.model_architecture,'') as arch,
           coalesce(vs.market,'h2h')          as mkt,
           vs.outcome                         as outc,
           count(*) filter (where vs.result in ('win','loss'))       as n,
           count(*) filter (where vs.result = 'win')                 as wins,
           sum(case when vs.result='win'  then vs.detected_odds - 1
                    when vs.result='loss' then -1 end)               as pl,
           avg(vs.clv)                                               as clv
    from public.value_signals vs
    where vs.result in ('win','loss')
    group by 1,2,3
  )
  select s.arch, s.mkt, s.outc, s.n::int,
         round(100.0 * s.wins / nullif(s.n,0), 1),
         round(100.0 * s.pl   / nullif(s.n,0), 1),
         round(100.0 * s.clv, 2),
         coalesce(mco.sigma_multiplier, 1.0),
         -- Widen sigma where CLV is negative, tighten where positive.
         -- Bounded 0.8 - 2.0 so one bad run cannot switch an outcome off.
         round(least(2.0, greatest(0.8, 1.0 - coalesce(s.clv,0) * 4)), 3),
         case
           when s.n < p_min_n then format('HOLD - %s settled, need %s', s.n, p_min_n)
           when abs(coalesce(s.clv,0)) < 0.01 then 'NO CHANGE - CLV within 1pp of flat'
           when s.clv < 0 then format('WIDEN - CLV %s%%', round(100*s.clv,2))
           else                format('TIGHTEN - CLV %s%%', round(100*s.clv,2))
         end
  from s
  left join public.model_calibration_outcome mco
    on  mco.model_architecture = s.arch
    and mco.market  = s.mkt
    and mco.outcome = s.outc
  order by s.n desc;

  if p_apply then
    update public.model_calibration_outcome mco
    set sigma_multiplier = sub.mult,
        n_settled        = sub.n,
        measured_clv     = sub.clv,
        measured_yield   = sub.yld,
        source           = 'measured',
        calibrated_at    = now()
    from (
      select coalesce(vs.model_architecture,'') as arch,
             coalesce(vs.market,'h2h')          as mkt,
             vs.outcome                         as outc,
             count(*)                           as n,
             avg(vs.clv)                        as clv,
             sum(case when vs.result='win' then vs.detected_odds-1 else -1 end)
               / nullif(count(*),0)             as yld,
             least(2.0, greatest(0.8, 1.0 - coalesce(avg(vs.clv),0) * 4)) as mult
      from public.value_signals vs
      where vs.result in ('win','loss')
      group by 1,2,3
      having count(*) >= p_min_n
    ) sub
    where mco.model_architecture = sub.arch
      and mco.market  = sub.mkt
      and mco.outcome = sub.outc;
  end if;
end;
$$;

commit;

-- ============================================================================
-- Verify
-- ============================================================================
-- Neutral to start, as intended:
--   select * from public.model_calibration_outcome order by 1,2,3;
--
-- Coverage gate refuses rather than falls back:
--   select public.coverage_penalty(0), public.coverage_penalty(29),
--          public.coverage_penalty(30), public.coverage_penalty(400);
--   -- expect: NULL, NULL, 1.70, 1.00
--
-- End to end -- a 3pp gap on a well-covered DIXON_COLES away selection:
--   select public.maxedge_score(
--            0.03,
--            public.effective_sigma('DIXON_COLES','h2h','away',500),
--            1.0);
--   -- expect 65, because every multiplier starts neutral
--
-- Dry run the outcome measurement:
--   select * from public.refresh_outcome_calibration();
-- ============================================================================
