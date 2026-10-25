-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260807182608, name no_score_without_a_measured_sigma. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

-- A SIGNAL MAY NOT CARRY A SCORE UNLESS ITS ARCHITECTURE HAS A MEASURED σ.
--
-- WHY. The MaxEdgeScore is 100·(1 − 0.35^(gap/σ)). σ is not a parameter, it is
-- the UNIT the score is denominated in, and it comes from `model_calibration`
-- because it is MEASURED. An architecture nobody has measured has no σ, and
-- therefore cannot have a score — that rule is written into lib/maxedge.ts and
-- lib/publication.ts in the browser, where it fails closed.
--
-- It was not enforced anywhere the writer could see it. Found 7 Aug 2026:
-- LAMBDA_MC has NO ROW IN `model_calibration` at all — never calibrated, no
-- publish ruling, nothing — and had written 16 scored signals in 24 hours, each
-- carrying `model_sigma = 0.03`, a number the engine supplied because there was
-- nothing to read. One of them was broadcast to the channel on 6 Aug.
--
-- The browser was never at risk: LAMBDA_MC is in neither `PUBLICATION` nor
-- `MODEL_SIGMA`, so it is filtered from every read and would score null anyway.
-- That is exactly the problem. The disqualification of a model lived ENTIRELY in
-- read-side filters, so the guarantee held only as long as every current and
-- future query remembered `.in('model_architecture', PUBLISHED_ARCHITECTURES)`.
-- Fail-open by default, with one omission between a model the audit called
-- "NOT A MODEL" and a paying customer.
--
-- WHAT THIS ENFORCES, and deliberately no more:
--
--   1. No `model_calibration` row, or a null/non-positive `sigma_p` → no score.
--   2. `model_sigma` on the row must EQUAL the table's `sigma_p` → else no
--      score. Zero rows violate this today, and hand-copied sigmas have already
--      drifted three times in two days, twice into production.
--
-- WHAT IT DELIBERATELY DOES NOT ENFORCE: `publish`. A disqualified architecture
-- keeps its scores. MARKET_CONSENSUS, API_PREDICTIVE, CORNERS_MODEL and
-- CARDS_MODEL are all measured and all withheld from readers — and they have to
-- keep accumulating settled results, because that is the only way one of them
-- ever earns publication back through `paper_trade_gate()`. Nulling their scores
-- would break the process that could re-qualify them. Publication is a
-- READ-side, owner-decision surface and stays one; measurement is a write-side
-- fact and belongs here.
--
-- IT NULLS RATHER THAN RAISES. Signals are the product; a trigger that aborts
-- ingestion because a model is miscalibrated turns a data-quality problem into
-- an outage. The row is written, the claim is withheld, and the reason is
-- recorded so the withholding is visible instead of silent.

alter table public.value_signals
  add column if not exists score_withheld_reason text;

comment on column public.value_signals.score_withheld_reason is
  'Set by trg_score_needs_measured_sigma when mxs/mxs_band/model_sigma were '
  'withheld at write time because the architecture has no measured sigma in '
  'model_calibration, or the row disagreed with it. NULL means the score stands.';

create or replace function public.score_needs_measured_sigma()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  cal_sigma numeric;
  found_cal boolean;
begin
  -- Nothing claimed, nothing to check.
  if new.mxs is null and new.mxs_band is null then
    new.score_withheld_reason := null;
    return new;
  end if;

  select mc.sigma_p, true into cal_sigma, found_cal
  from model_calibration mc
  where mc.model_architecture = new.model_architecture;

  if new.model_architecture is null then
    new.score_withheld_reason := 'no model_architecture on the row — an edge that cannot be attributed cannot be scored';
  elsif not coalesce(found_cal, false) then
    new.score_withheld_reason := format(
      '%s has no row in model_calibration — nothing has measured its error bar, so it has no sigma and can have no score',
      new.model_architecture);
  elsif cal_sigma is null or cal_sigma <= 0 then
    new.score_withheld_reason := format(
      '%s is in model_calibration with no usable sigma_p (%s)', new.model_architecture, coalesce(cal_sigma::text, 'null'));
  elsif new.model_sigma is null then
    new.score_withheld_reason := format(
      '%s carries a score with no model_sigma, so it cannot be checked against the measured %s',
      new.model_architecture, cal_sigma);
  elsif abs(new.model_sigma - cal_sigma) > 1e-9 then
    new.score_withheld_reason := format(
      '%s was scored against sigma %s but model_calibration measures %s',
      new.model_architecture, new.model_sigma, cal_sigma);
  else
    new.score_withheld_reason := null;
    return new;   -- measured, and the row agrees with the measurement.
  end if;

  -- Withheld: the prices, the edge and the probabilities are facts about the
  -- row and survive. Only the CLAIM goes — the same shape as the publication
  -- gate and as expireKickedOffClaims() in the browser.
  new.mxs := null;
  new.mxs_band := null;
  new.model_sigma := null;
  return new;
end $$;

drop trigger if exists trg_score_needs_measured_sigma on public.value_signals;
create trigger trg_score_needs_measured_sigma
  before insert or update on public.value_signals
  for each row execute function public.score_needs_measured_sigma();

-- Clean the rows already written this way. These are not a historical record of
-- a judgement we made — they are a judgement made against a number nobody
-- measured, which is a different thing and worth less than the em-dash that
-- replaces it.
with fixed as (
  update public.value_signals v
     set mxs = null, mxs_band = null, model_sigma = null,
         score_withheld_reason = format(
           '%s has no row in model_calibration — scored against an invented sigma before the write-side guard existed (backfilled 7 Aug 2026)',
           v.model_architecture)
   where v.mxs is not null
     and not exists (
       select 1 from model_calibration mc
       where mc.model_architecture = v.model_architecture
         and mc.sigma_p is not null and mc.sigma_p > 0)
  returning 1)
select count(*) as rows_cleaned from fixed;

-- A one-query health check, so this surfaces without anyone having to ask.
create or replace view public.uncalibrated_writers
with (security_invoker = true) as
select v.model_architecture,
       count(*)                                        as signals_all_time,
       count(*) filter (where v.detected_at > now() - interval '24 hours') as signals_24h,
       max(v.detected_at)                              as last_write,
       count(*) filter (where v.score_withheld_reason is not null) as scores_withheld,
       (select mc.publish from model_calibration mc
         where mc.model_architecture = v.model_architecture) as publish
from public.value_signals v
where not exists (
  select 1 from model_calibration mc
  where mc.model_architecture = v.model_architecture
    and mc.sigma_p is not null and mc.sigma_p > 0)
group by v.model_architecture
order by signals_24h desc, signals_all_time desc;

comment on view public.uncalibrated_writers is
  'Architectures writing value_signals with no measured sigma in '
  'model_calibration. Should be empty. A non-empty row means a model is running '
  'that nothing has calibrated — see LAMBDA_MC, 7 Aug 2026.';
