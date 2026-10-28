-- Backfilled from the Supabase migration ledger (supabase_migrations.schema_migrations)
-- version 20260903160700, name 121_the_guard_only_explained_the_scores_it_stripped. Applied directly to production; this file was
-- missing from the repo. Statements copied verbatim from the ledger on 25 Oct 2026.
-- DO NOT re-apply: it is already in the database. Nothing runs this folder.

create or replace function public.score_needs_measured_sigma()
 returns trigger
 language plpgsql
 set search_path to 'public', 'pg_temp'
as $function$
declare
  cal_sigma numeric;
  found_cal boolean;
begin
  select mc.sigma_p, true into cal_sigma, found_cal
  from model_calibration mc
  where mc.model_architecture = new.model_architecture;

  -- NO CLAIM ON THE ROW. The writer never attempted a score, so there is
  -- nothing to check - but there IS something to say, and until migration 121
  -- this branch said none of it. A reason already on the row is the caller's
  -- and is preserved: a backfill explaining its own strip arrives looking
  -- exactly like this, and so does a row 060's overround guard has just
  -- stripped (it runs first, alphabetically).
  if new.mxs is null and new.mxs_band is null then
    if new.score_withheld_reason is null then
      if new.model_architecture is null then
        new.score_withheld_reason :=
          'no model_architecture on the row — an edge that cannot be attributed cannot be scored';
      elsif not coalesce(found_cal, false) then
        new.score_withheld_reason := format(
          '%s has no row in model_calibration — nothing has measured its error bar, so it has no sigma and can have no score',
          new.model_architecture);
      elsif cal_sigma is null or cal_sigma <= 0 then
        new.score_withheld_reason := format(
          '%s is in model_calibration with no usable sigma_p (%s)',
          new.model_architecture, coalesce(cal_sigma::text, 'null'));
      else
        new.score_withheld_reason := format(
          '%s is calibrated (sigma_p %s) and the row arrived with no score — its writer declined to score it; this guard stripped nothing',
          new.model_architecture, cal_sigma);
      end if;
    end if;
    return new;
  end if;

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
    return new;
  end if;

  new.mxs := null;
  new.mxs_band := null;
  new.model_sigma := null;
  return new;
end $function$;

do $$
declare
  v_match  uuid;
  v_reason text;
  v_mxs    int;
  v_sigma  numeric;
  v_band   text;
  v_landed boolean;
begin
  select id into v_match from public.matches limit 1;
  if v_match is null then
    raise exception '121 CANNOT PROBE: matches is empty';
  end if;

  select sigma_p into v_sigma
  from public.model_calibration
  where model_architecture = 'MARKET_ANCHORED' and sigma_p is not null and sigma_p > 0;
  if v_sigma is null then
    raise exception '121 CANNOT PROBE: MARKET_ANCHORED has no usable sigma_p';
  end if;

  select public.maxedge_band(50) into v_band;

  v_reason := null; v_landed := false;
  begin
    insert into public.value_signals
      (match_id, outcome, market, detected_odds, detected_edge,
       model_architecture, phase, result, signal_category)
    values (v_match, 'home', 'h2h', 2.01, 0.05, 'INPLAY_DIXON_COLES', 'inplay', 'pending', 'value')
    returning score_withheld_reason into v_reason;
    v_landed := found;
    raise exception 'PROBE_ROLLBACK';
  exception when others then
    if sqlerrm <> 'PROBE_ROLLBACK' then raise; end if;
  end;
  if not v_landed then
    raise exception '121 CANNOT PROBE (a): the insert never landed';
  end if;
  if v_reason is null or v_reason not like '%no row in model_calibration%' then
    raise exception '121 FAILED (a): an uncalibrated arriving null is still silent (reason: %)', coalesce(v_reason, 'NULL');
  end if;

  v_reason := null; v_landed := false;
  begin
    insert into public.value_signals
      (match_id, outcome, market, detected_odds, detected_edge,
       model_architecture, phase, result, signal_category)
    values (v_match, 'home', 'h2h', 2.02, 0.05, 'MARKET_ANCHORED', 'prematch', 'pending', 'value')
    returning score_withheld_reason into v_reason;
    v_landed := found;
    raise exception 'PROBE_ROLLBACK';
  exception when others then
    if sqlerrm <> 'PROBE_ROLLBACK' then raise; end if;
  end;
  if not v_landed then
    raise exception '121 CANNOT PROBE (b): the insert never landed';
  end if;
  if v_reason is null or v_reason not like '%declined to score it%' then
    raise exception '121 FAILED (b): a calibrated arriving null is not explained (reason: %)', coalesce(v_reason, 'NULL');
  end if;
  if v_reason like '%no row in model_calibration%' then
    raise exception '121 FAILED (b): a calibrated row claims it has no calibration row';
  end if;

  v_reason := null; v_landed := false;
  begin
    insert into public.value_signals
      (match_id, outcome, market, detected_odds, detected_edge,
       model_architecture, phase, result, signal_category, score_withheld_reason)
    values (v_match, 'home', 'h2h', 2.03, 0.05, 'INPLAY_DIXON_COLES', 'inplay', 'pending', 'value',
            'a backfill removed this score and this is its own account of why')
    returning score_withheld_reason into v_reason;
    v_landed := found;
    raise exception 'PROBE_ROLLBACK';
  exception when others then
    if sqlerrm <> 'PROBE_ROLLBACK' then raise; end if;
  end;
  if not v_landed then
    raise exception '121 CANNOT PROBE (c): the insert never landed';
  end if;
  if v_reason is distinct from 'a backfill removed this score and this is its own account of why' then
    raise exception '121 FAILED (c): the caller''s reason was overwritten (now: %)', coalesce(v_reason, 'NULL');
  end if;

  v_reason := null; v_mxs := null; v_landed := false;
  begin
    insert into public.value_signals
      (match_id, outcome, market, detected_odds, detected_edge,
       model_architecture, phase, result, signal_category,
       market_prob, model_sigma, mxs, mxs_band)
    values (v_match, 'home', 'h2h', 2.04, 0.05, 'MARKET_ANCHORED', 'prematch', 'pending', 'value',
            0.4900, v_sigma, 50, v_band)
    returning score_withheld_reason, mxs into v_reason, v_mxs;
    v_landed := found;
    raise exception 'PROBE_ROLLBACK';
  exception when others then
    if sqlerrm <> 'PROBE_ROLLBACK' then raise; end if;
  end;
  if not v_landed then
    raise exception '121 CANNOT PROBE (d): the insert never landed';
  end if;
  if v_mxs is null then
    raise exception '121 FAILED (d): a correctly calibrated score was stripped';
  end if;
  if v_reason is not null then
    raise exception '121 FAILED (d): a clean scored row carries a reason (%)', v_reason;
  end if;

  v_reason := null; v_mxs := null; v_landed := false;
  begin
    insert into public.value_signals
      (match_id, outcome, market, detected_odds, detected_edge,
       model_architecture, phase, result, signal_category,
       market_prob, model_sigma, mxs, mxs_band)
    values (v_match, 'home', 'h2h', 2.05, 0.05, 'INPLAY_DIXON_COLES', 'inplay', 'pending', 'value',
            0.4900, 0.0300, 50, v_band)
    returning score_withheld_reason, mxs into v_reason, v_mxs;
    v_landed := found;
    raise exception 'PROBE_ROLLBACK';
  exception when others then
    if sqlerrm <> 'PROBE_ROLLBACK' then raise; end if;
  end;
  if not v_landed then
    raise exception '121 CANNOT PROBE (e): the insert never landed';
  end if;
  if v_mxs is not null then
    raise exception '121 FAILED (e): an uncalibrated score was NOT stripped';
  end if;
  if v_reason is null or v_reason not like '%no row in model_calibration%' then
    raise exception '121 FAILED (e): the strip path lost its reason (%)', coalesce(v_reason, 'NULL');
  end if;

  v_reason := null; v_mxs := null; v_landed := false;
  begin
    insert into public.value_signals
      (match_id, outcome, market, detected_odds, detected_edge,
       model_architecture, phase, result, signal_category,
       market_prob, model_sigma, mxs, mxs_band, gap_basis)
    values (v_match, 'home', 'h2h', 2.06, 0.05, 'MARKET_ANCHORED', 'prematch', 'pending', 'value',
            0.9000, v_sigma, 50, v_band, 'devigged')
    returning score_withheld_reason, mxs into v_reason, v_mxs;
    v_landed := found;
    raise exception 'PROBE_ROLLBACK';
  exception when others then
    if sqlerrm <> 'PROBE_ROLLBACK' then raise; end if;
  end;
  if not v_landed then
    raise exception '121 CANNOT PROBE (f): the insert never landed';
  end if;
  if v_mxs is not null then
    raise exception '121 FAILED (f): 060''s overround guard did not strip an impossible market_prob';
  end if;
  if v_reason is null or v_reason not like '%above 1%' then
    raise exception '121 FAILED (f): 060''s reason was replaced by this guard''s (now: %)', coalesce(v_reason, 'NULL');
  end if;

  raise notice '121: all six roads out of the guard are explained, and nothing scored was stripped.';
end $$;

do $$
declare v_trip int;
begin
  select count(*) into v_trip
  from public.value_signals
  where mxs is null and mxs_band is null and score_withheld_reason is null
    and market_prob is not null and detected_odds > 1
    and coalesce(gap_basis, 'devigged') <> 'implied'
    and market_prob * detected_odds > 1 + 0.00005 * detected_odds;
  if v_trip > 0 then
    raise exception '121 REFUSED: % candidate row(s) would trip 060 and lose market_prob', v_trip;
  end if;
  raise notice '121: no candidate trips 060; the backfill touches the reason column only.';
end $$;

update public.value_signals
set score_withheld_reason =
      'no model_architecture on the row — an edge that cannot be attributed cannot be scored'
where mxs is null and mxs_band is null and score_withheld_reason is null
  and model_architecture is null;

update public.value_signals v
set score_withheld_reason = format(
      '%s has no row in model_calibration — nothing has measured its error bar, so it has no sigma and can have no score',
      v.model_architecture)
where v.mxs is null and v.mxs_band is null and v.score_withheld_reason is null
  and v.model_architecture is not null
  and not exists (select 1 from public.model_calibration mc
                   where mc.model_architecture = v.model_architecture);

update public.value_signals v
set score_withheld_reason = format(
      '%s is in model_calibration with no usable sigma_p (%s)',
      v.model_architecture, coalesce(mc.sigma_p::text, 'null'))
from public.model_calibration mc
where mc.model_architecture = v.model_architecture
  and v.mxs is null and v.mxs_band is null and v.score_withheld_reason is null
  and (mc.sigma_p is null or mc.sigma_p <= 0);

update public.value_signals v
set score_withheld_reason = format(
      '%s is calibrated (sigma_p %s) and the row arrived with no score — its writer declined to score it; this guard stripped nothing',
      v.model_architecture, mc.sigma_p)
from public.model_calibration mc
where mc.model_architecture = v.model_architecture
  and v.mxs is null and v.mxs_band is null and v.score_withheld_reason is null
  and mc.sigma_p is not null and mc.sigma_p > 0;

do $$
declare v_silent int;
begin
  select count(*) into v_silent
  from public.value_signals
  where mxs is null and mxs_band is null and score_withheld_reason is null;
  if v_silent > 0 then
    raise exception '121 FAILED: % row(s) still carry a null score with no reason', v_silent;
  end if;
  raise notice '121: no unexplained null score remains.';
end $$;
