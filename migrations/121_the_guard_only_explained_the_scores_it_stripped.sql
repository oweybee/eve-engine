-- 121_the_guard_only_explained_the_scores_it_stripped.sql
--
-- NUMBERED 121 BECAUSE THE DATABASE IS AHEAD OF `main` AGAIN. The repo stops
-- at 120; production also carries `performance_signals_view`,
-- `performance_signals_split`, `scoring_anchor_public_read`,
-- `band_window_opens_at_the_epoch_not_midnight`,
-- `gate_promotable_value_signals_against_stale_fixtures` and
-- `add_signal_health_check_view`, the last two applied on 3 Sep 2026. Same
-- resolution 059 and 108 both record: the file number follows what the
-- database holds. Read the table, not the migration.
--
-- ── A SCORE THAT WAS NEVER ATTEMPTED WAS NEVER EXPLAINED ────────────────────
--
-- `score_needs_measured_sigma()` opens with:
--
--     if new.mxs is null and new.mxs_band is null then
--       return new;
--     end if;
--
-- So the guard explains a score it STRIPS and says nothing about a score that
-- never arrived. The engine's own scorer fails closed — `scoreSignal` returns
-- nulls for every field when an architecture has no measured sigma, which is
-- the fail-closed direction working — so those rows insert with `mxs` already
-- null, take the early return, and land with no score AND NO REASON.
--
-- Two guards, each correct on its own, and the audit trail falls down the gap
-- between them. Nothing throws and nothing logs, so the only trace is an
-- em-dash where a rung would be. Measured against production, 3 Sep 2026, over
-- rows carrying no `mxs`, no `mxs_band` and no `score_withheld_reason`:
--
--     cause the guard can determine            rows   since 1 Sep
--     no row in model_calibration               390            46
--       INPLAY_DIXON_COLES, SECOND_HALF_SNIPER
--     calibrated, and the writer declined        65             6
--       MARKET_ANCHORED, MARKET_CONSENSUS
--     no model_architecture at all               17             0
--                                               ---
--                                               472
--
-- **IT IS LIVE, NOT HISTORICAL RESIDUE, AND MIGRATION 108 IS WHY.** 390 of the
-- 472 belong to the two in-play writers that 108 made storable on 26 Aug —
-- they could not write a row at all before that, so this whole population is
-- eight days old. September alone: 52 silent nulls of 84 signals written, and
-- ZERO explained ones. 108 did exactly what it set out to do (the engine keeps
-- its work now) and the reason column did not keep up with it.
--
-- ── WHAT THIS DOES NOT DO, AND THAT IS THE IMPORTANT HALF ───────────────────
--
-- **NO CHECK CONSTRAINT.** The obvious shape — `check (mxs is not null or
-- score_withheld_reason is not null)` — would reject every in-play insert the
-- moment an architecture is uncalibrated, which is precisely the state the
-- fail-closed scorer is designed to write in. That converts a silent audit gap
-- into an ingestion outage and repeals the rule this guard was built on:
-- "It NULLS rather than RAISES: signals are the product, and a miscalibrated
-- model must not become an ingestion outage." The guard fills the reason in;
-- it does not start refusing rows.
--
-- **NOTHING IS SCORED THAT WAS NOT SCORED BEFORE.** No row gains an `mxs`, an
-- `mxs_band` or a `model_sigma` here. The strip path is byte-for-byte the one
-- 060-era code shipped. Publication, RLS and the eligibility ladder are all
-- untouched, so no surface renders anything it did not render an hour ago —
-- what changes is that `score_withheld_reason` now answers the question the
-- column exists to answer.
--
-- **A REASON ALREADY ON THE ROW IS THE CALLER'S AND SURVIVES.** That clause is
-- load-bearing rather than defensive, for two reasons. The original comment
-- records the first: "a backfill explaining why it removed a score arrives
-- looking exactly like this", and 060 wrote two such backfills. The second is
-- an ordering fact nobody had to think about while this branch was silent —
-- same-timing triggers fire in ALPHABETICAL order, so
-- `trg_score_needs_coherent_market_prob` runs BEFORE
-- `trg_score_needs_measured_sigma`. When 060's overround guard strips a claim
-- it sets its own, more specific reason ("the de-vigged fair line beats the
-- price it was taken from") and then hands this guard a null score with a
-- reason attached. Filling unconditionally would overwrite the better
-- sentence with a vaguer one. Probed below, both directions.
--
-- ── THE WORDING IS DELIBERATELY THE SAME AS THE STRIP PATH'S ────────────────
--
-- For an uncalibrated architecture the fact is identical whichever road the
-- row arrived by — nothing measured its error bar, so it can have no score —
-- so it gets the identical sentence rather than a second phrasing of one
-- fact. That also keeps `model_detail()`'s census working: migration 086
-- buckets by `like '%no row in model_calibration%'`, and a paraphrase would
-- have fallen into 'other' while looking correct on the row.
--
-- The FOURTH cause has no counterpart on the strip path and is new: the
-- architecture IS calibrated and the row still arrived unscored. The guard
-- cannot know which of the engine's own refusals fired — no de-vigged fair
-- line, an incomplete market, a price too old — so it does not guess. It says
-- what it does know, which is that the writer declined and the database
-- stripped nothing, and points the reader at the engine.
--
-- **STILL OPEN, AND IT IS 086's:** `model_detail()`'s withheld census has
-- three families and this adds a fourth cause, so those 65 rows land in
-- 'other'. Nothing renders that census today — the 23 Aug rewrite of
-- `/models/[id]` removed the score-withholding panel — so this is a staleness
-- to close deliberately, not a live defect, and re-issuing an 86-line
-- SECURITY DEFINER function to add a CASE arm is not this migration's job.
--
-- Reversible: the previous function body is in 060's migration and in
-- `pg_get_functiondef` output quoted in this session's notes; the backfill is
-- additive and can be undone with
--   update public.value_signals set score_withheld_reason = null
--   where mxs is null and mxs_band is null and score_withheld_reason like '%';
-- though there is no reason to — a filled reason revises no measurement.

begin;

-- ── 1. The guard explains an arriving null too ──────────────────────────────
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
  -- nothing to check — but there IS something to say, and until migration 121
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
        -- Calibrated, and still no score. The guard cannot know WHICH of the
        -- engine's own refusals fired, so it does not guess — it records that
        -- the writer declined and that this guard stripped nothing.
        new.score_withheld_reason := format(
          '%s is calibrated (sigma_p %s) and the row arrived with no score — its writer declined to score it; this guard stripped nothing',
          new.model_architecture, cal_sigma);
      end if;
    end if;
    return new;
  end if;

  -- ── The strip path, unchanged ────────────────────────────────────────────
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
end $function$;

-- 2. Probe every road; every probe rolls itself back
-- Each probe INSERTS and reads the stored value back through RETURNING, so a
-- row swallowed by `trg_dedupe_value_signals` (BEFORE INSERT, and it can
-- return NULL) is caught rather than mistaken for a pass.
--
-- PLPGSQL HAS NO `SAVEPOINT`, so each probe is a BEGIN/EXCEPTION block and
-- the rollback is a deliberate `raise` caught by its own handler — the shape
-- 108 used. A variable assigned before the raise SURVIVES it (plpgsql locals
-- are not transactional), which is what lets the assertions run on the
-- stored value AFTER the row is gone. The assertions sit OUTSIDE the block
-- on purpose: inside, a failing assertion would be swallowed by the same
-- handler that swallows the rollback. Nothing here survives the migration.
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

  -- (a) Uncalibrated architecture, no score attempted. The case that was
  --     silent, and the 390-row population.
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

  -- (b) Calibrated architecture, and the writer still declined. The new
  --     fourth cause, and it must not borrow one of the other three.
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

  -- (c) A reason the CALLER supplied is preserved verbatim. This is what keeps
  --     060's backfills and its overround guard intact.
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

  -- (d) A correctly calibrated, correctly scored row passes through untouched
  --     and carries NO reason. The regression that matters most: this branch is
  --     how every scored row on the board reaches a reader.
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

  -- (e) The strip path still strips: a score from an uncalibrated writer.
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

  -- (f) THE ORDERING CASE. 060's overround guard runs first, strips the claim
  --     and sets its own reason; this guard then sees a null score with a
  --     reason attached and must leave the more specific sentence standing.
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

-- One statement per cause, so each WHERE names the fact it is recording.
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

-- 4. Assert the gap is closed
-- Not "472 rows changed" - rows are still being written while this runs, and a
-- fixed count would be a claim about the minute it was measured in. The
-- invariant is the one that matters: no row carries a null score with nothing
-- to say about it.
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

commit;
