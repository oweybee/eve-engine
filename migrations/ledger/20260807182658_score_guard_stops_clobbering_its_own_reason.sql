-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260807182658, name score_guard_stops_clobbering_its_own_reason. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

-- The guard was erasing its own audit trail.
--
-- `score_needs_measured_sigma()` early-returned when a row arrived with no
-- score — correctly, there is nothing to check — but it also set
-- `score_withheld_reason := null` on that path. So the backfill in the previous
-- migration, which nulls `mxs` AND writes the reason in one UPDATE, tripped its
-- own BEFORE UPDATE trigger: the trigger saw a scoreless row and wiped the
-- explanation. All 20 LAMBDA_MC rows came out correctly unscored and completely
-- silent about why — which is the exact failure mode ("withheld, invisibly")
-- the reason column was added to prevent.
--
-- ABSENCE OF A SCORE IS NOT EVIDENCE THAT NOTHING WAS WITHHELD. A row can be
-- unscored because it was never scored, or because the guard took the score
-- away, and only the second has a reason to record. So the no-score path now
-- leaves the column exactly as the caller wrote it. The column is still cleared
-- on the path that matters — a row that arrives with a VALID score is
-- affirmatively fine, and must not carry a stale explanation from an earlier
-- state.

create or replace function public.score_needs_measured_sigma()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  cal_sigma numeric;
  found_cal boolean;
begin
  -- No claim on the row: nothing to check, and nothing to say. Whatever reason
  -- the caller supplied is theirs — a backfill explaining why it removed a
  -- score arrives looking exactly like this.
  if new.mxs is null and new.mxs_band is null then
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
    -- Measured, and the row agrees with the measurement. Clear any stale reason.
    new.score_withheld_reason := null;
    return new;
  end if;

  new.mxs := null;
  new.mxs_band := null;
  new.model_sigma := null;
  return new;
end $$;

-- Re-state the reason the first backfill wrote and the trigger then erased.
update public.value_signals v
   set score_withheld_reason = format(
     '%s has no row in model_calibration — scored against an invented sigma before the write-side guard existed (backfilled 7 Aug 2026)',
     coalesce(v.model_architecture, 'a row with no architecture'))
 where v.mxs is null
   and v.score_withheld_reason is null
   and v.detected_at > timestamptz '2026-08-01 00:00:00+00'
   and v.model_architecture is not null
   and not exists (
     select 1 from model_calibration mc
     where mc.model_architecture = v.model_architecture
       and mc.sigma_p is not null and mc.sigma_p > 0);
