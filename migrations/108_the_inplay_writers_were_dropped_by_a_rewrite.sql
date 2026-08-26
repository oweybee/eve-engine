-- 108_the_inplay_writers_were_dropped_by_a_rewrite.sql
--
-- NUMBERED 108, NOT 096, AND THE GAP IS REAL. `main` stops at 095, but the
-- DATABASE already carries 096 through 107, applied on 26 Aug 2026 between
-- 10:17 and 13:13 UTC from a branch that has not merged (band calibration,
-- the bookmaker tables, performance-by-band, `107_revoke_public_execute`).
-- Same situation migration 059's header records — "applied as 058; renumbered
-- when 058_gap_basis.sql reached main first" — and the same resolution: the
-- file number follows what the database actually holds, so a `list_migrations`
-- and an `ls migrations/` never disagree about which 096 is which.
--
-- None of 096-107 touched this constraint; re-read from production AFTER 107
-- landed rather than trusting the reading taken at the start of the session.
-- Read the table, not the migration.
--
-- THE IN-PLAY ENGINE HAS NEVER WRITTEN A SIGNAL, AND THIS IS WHY.
-- `value_signals` holds ZERO rows with `phase = 'inplay'` — not "insufficient",
-- zero, since the phase column was added in migration 030. The pipeline runs:
-- `run-inplay.yml` has completed 1,290 times, its recent runs are green, and
-- two of its four stages are ENABLED in the workflow env
-- (`INPLAY_WINPROB_ENABLED: 'true'`, `SECOND_HALF_SNIPER_ENABLED: 'true'`).
-- Its own log, 25 Aug 2026 20:57 UTC:
--
--     [inplay] win-prob: 18/18 live match(es) have a baseline; 0 candidate(s)
--     [inplay] second-half sniper: 0 candidate(s) from 18 live match(es)
--
-- Candidates ARE produced. Replayed over the 3,798 h2h selection-ticks in
-- `inplay_market_series` that carry a model probability and a finite minute
-- under `INPLAY_WINPROB_MINUTE_CAP`, re-priced against the same 24-hour odds
-- window `fetchMatchesForComputation` hands `bestH2hOdds`:
--
--     would fire (edge 2%-20%)          355   (9.3%)
--     rejected above INPLAY_MAX_EDGE  2,760   (72.7%)
--     below the 2% threshold            683
--
-- Every one of those 355 was rejected by POSTGRES, not by the engine.
--
-- ── THE ENUMERATION WAS REWRITTEN AND THREE NAMES FELL OUT ─────────────────
--
-- Every migration that has ever touched this constraint drops it and re-adds
-- the WHOLE array, so a new architecture is added by copying the previous
-- list — and one of them copied the wrong list:
--
--     028   8 names                                    (no in-play)
--     030   + SUPERMODEL_HALFTIME                      9
--     038   + INPLAY_DIXON_COLES, SECOND_HALF_SNIPER  11   <- in-play storable
--     039   + LAMBDA_MC, rebuilt from 028's list       9   <- all three GONE
--     055   + MARKET_ANCHORED                         10   <- inherits the loss
--
-- 039 did not repeal 030 and 038 on purpose; it re-declared the enumeration
-- from an older copy of it. Nothing failed, because a CHECK is only felt by a
-- writer, and the only writers affected were the in-play stages — which were
-- not enabled until later. By the time they were, the reason they were silent
-- had been in the schema for a month.
--
-- 055 was looking straight at this list when it recorded a DIFFERENT latent
-- bug in the same constraint ("admits ML_ENSEMBLE, XGBOOST_PREMATCH and
-- SUPERMODEL_PREMATCH but NOT 'SUPERMODEL'") and did not notice three missing
-- names beside it. Reading a list for one absence does not find another.
--
-- ── AND THE FAILURE IS REPORTED AS SUCCESS ─────────────────────────────────
--
-- `insertModelSignals` swallows only `/duplicate key/`, so a check violation
-- throws — into `winProbStage`'s own try/catch in computeInplayValues.js,
-- which logs `[inplay] win-prob stage failed:` and lets the job exit 0. The
-- same shape as "Nothing counted the ways the pipeline can die quietly": a
-- guard the pipeline reports success through. This migration removes the
-- cause; the swallow is left alone because a miscalibrated model must still
-- not become an ingestion outage.
--
-- ── WHAT THIS ADMITS, AND WHAT IT DELIBERATELY DOES NOT ────────────────────
--
-- The three names 030 and 038 admitted and 039 dropped, and nothing else:
--
--     INPLAY_DIXON_COLES    Stage 3, win-prob vs the frozen inplay_baseline
--     SECOND_HALF_SNIPER    Stage 4, half-time Over on a hot scoreline
--     SUPERMODEL_HALFTIME   Stage 2, dormant (INPLAY_MODEL_ENABLED=false)
--
-- Those are exactly the in-play names `computeInplayValues.js` writes; checked
-- against the source rather than against this comment. `INPLAY_MODEL` is an
-- env var and a display label and is written NOWHERE, so it is not added — a
-- name for a writer that does not exist is what 055 declined to add for
-- 'SUPERMODEL' and the reasoning is unchanged.
--
-- **'ELO' IS STILL EXCLUDED AND THAT IS ASSERTED BELOW.** Migration 088 gave
-- ELO a measured sigma precisely BECAUSE this constraint keeps it from
-- writing: "letting ELO write signals is the product starting to back ELO
-- selections, a far larger ruling than a calibration." 088 asserts the
-- exclusion; widening the constraint without re-asserting it would quietly
-- retire a ruling nobody revisited.
--
-- MARKET_CONSENSUS stays for 055's reason: historic rows carry it and must
-- keep validating. The architecture is retired at the writer, not in the
-- schema.
--
-- ── THIS DOES NOT PUBLISH ANYTHING, AND THAT IS THE POINT ──────────────────
--
-- Storable is not publishable, and four independent gates keep it that way.
-- Verified against production before this was written:
--
--   1. RLS. `pending_needs_a_publishing_architecture` is RESTRICTIVE on anon
--      and authenticated: a PENDING row is readable only if its architecture
--      has `publish = true` in `model_calibration`. None of the three has a
--      ROW in that table at all, so the EXISTS is false and every browser
--      seat — free or Plus — is denied. Asserted below.
--   2. The score. `trg_score_needs_measured_sigma` strips mxs / mxs_band /
--      model_sigma from any architecture with no measured sigma_p, so these
--      rows carry no score and no rung and record `score_withheld_reason`.
--   3. The browser. `lib/publication.ts` fails closed on a name it has not
--      heard of, independently of anything in this database.
--   4. Telegram. `postToX.js` routes `phase='inplay'` to
--      TELEGRAM_INPLAY_CHAT_ID and skips when it is unset — it is unset in
--      run-inplay.yml, verified in the run log ("no channel for phase=...").
--
-- So what changes is that the in-play stages start KEEPING their work.
-- `settle_match_signals()` already handles them — it sets closing_odds and
-- both CLV measures to null for `phase='inplay'` with a comment saying why —
-- so they settle into the `performance_summary` row keyed 'inplay', which has
-- been sitting at zero since it was created. That is rollout step 2 of
-- scripts/inplay-vps/README.md, reached at last: recorded, not posted.
--
-- ── HOW MUCH IT WILL WRITE ─────────────────────────────────────────────────
--
-- `value_signals_selection_price_unique` is
-- (match_id, market, outcome, model_architecture, DETECTED_ODDS) — the price
-- is IN the key, so this is not one row per fixture whatever
-- insertModelSignals' comment says. Counting distinct keys rather than ticks
-- over the same replay: **341 rows across 16 observed days, ~21 a day.**
--
-- That is the CURRENT cadence. `run-inplay.yml` delivers ~40 runs a day; the
-- 30-second worker in scripts/inplay-vps/ would tick ~100x more often and, with
-- the price in the unique key, would write proportionally more. Watch the row
-- count for a week before enabling that worker, and read
-- `select count(*) from value_signals where phase='inplay'` rather than
-- assuming this estimate survived the cadence change.
--
-- Reversible, and the revert is the state this repairs:
--   alter table public.value_signals
--     drop constraint value_signals_model_architecture_check;
--   alter table public.value_signals
--     add constraint value_signals_model_architecture_check
--     check (model_architecture is null or model_architecture = any (array[
--       'MARKET_ANCHORED','MARKET_CONSENSUS','DIXON_COLES','API_PREDICTIVE',
--       'CORNERS_MODEL','CARDS_MODEL','LAMBDA_MC','ML_ENSEMBLE',
--       'XGBOOST_PREMATCH','SUPERMODEL_PREMATCH']));

begin;

-- ── 1. No existing row may be invalidated ──────────────────────────────────
-- This only ever ADDS names, so it cannot be, but assert it rather than argue
-- it: a constraint that rejects rows already in the table turns any future
-- restore or backfill into a failure, which is 055's rule for MARKET_CONSENSUS
-- stated as a check instead of a comment.
do $$
declare v_bad text;
begin
  select string_agg(distinct model_architecture, ', ')
    into v_bad
  from public.value_signals
  where model_architecture is not null
    and model_architecture <> all (array[
      'MARKET_ANCHORED','MARKET_CONSENSUS','DIXON_COLES','API_PREDICTIVE',
      'CORNERS_MODEL','CARDS_MODEL','LAMBDA_MC','ML_ENSEMBLE',
      'XGBOOST_PREMATCH','SUPERMODEL_PREMATCH',
      'INPLAY_DIXON_COLES','SECOND_HALF_SNIPER','SUPERMODEL_HALFTIME']);
  if v_bad is not null then
    raise exception '108 REFUSED: rows already carry architectures this list omits: %', v_bad;
  end if;
end $$;

-- ── 2. The constraint ──────────────────────────────────────────────────────
alter table public.value_signals
  drop constraint if exists value_signals_model_architecture_check;

alter table public.value_signals
  add constraint value_signals_model_architecture_check
  check (model_architecture is null or model_architecture = any (array[
    -- pre-match, publishing
    'MARKET_ANCHORED',       -- Shin-de-vigged Pinnacle vs the panel
    'DIXON_COLES',           -- the goals model (totals / btts)
    -- pre-match, withheld; historic rows must keep validating (055)
    'MARKET_CONSENSUS',
    'API_PREDICTIVE',
    'CORNERS_MODEL',
    'CARDS_MODEL',
    'LAMBDA_MC',
    'ML_ENSEMBLE',
    'XGBOOST_PREMATCH',
    'SUPERMODEL_PREMATCH',
    -- in-play: admitted by 030 and 038, dropped by 039's rewrite, restored here
    'INPLAY_DIXON_COLES',    -- Stage 3, win-prob vs the frozen baseline
    'SECOND_HALF_SNIPER',    -- Stage 4, half-time Over on a hot scoreline
    'SUPERMODEL_HALFTIME'    -- Stage 2, dormant behind INPLAY_MODEL_ENABLED
    -- 'ELO' IS NOT HERE ON PURPOSE. See migration 088.
  ]));

-- ── 3. Assert what it now admits, and what it still refuses ────────────────
-- Probed with REAL inserts, each inside a BEGIN/EXCEPTION block — which is a
-- savepoint — that always raises before it ends, so every probe row is rolled
-- back and NOTHING is written, not even briefly. The assertion therefore tests
-- the CONSTRAINT rather than a reading of it. Migration 056 probed its own
-- contraction the same way; a delete-afterwards version of this would fire the
-- write-layer triggers on a row nobody asked for.
do $$
declare
  v_match uuid;
  v_arch  text;
  v_ok    boolean;
begin
  select id into v_match from public.matches limit 1;
  if v_match is null then
    raise exception '108 FAILED: no match to probe against';
  end if;

  -- 3a. the three in-play writers must be ACCEPTED
  foreach v_arch in array array['INPLAY_DIXON_COLES','SECOND_HALF_SNIPER','SUPERMODEL_HALFTIME'] loop
    v_ok := false;
    begin
      insert into public.value_signals
        (match_id, outcome, market, detected_odds, detected_edge,
         model_architecture, phase, result, signal_category)
      values (v_match, 'home', 'h2h', 2.00, 0.05, v_arch, 'inplay', 'pending', 'value');
      -- Accepted. Undo it by raising out of this savepoint.
      raise exception 'PROBE_ACCEPTED';
    exception
      when check_violation then v_ok := false;
      when others then
        if sqlerrm = 'PROBE_ACCEPTED' then v_ok := true; else raise; end if;
    end;
    if not v_ok then
      raise exception '108 FAILED: % is still rejected by the constraint', v_arch;
    end if;
  end loop;

  -- 3b. ELO must STILL be refused — migration 088's ruling, re-asserted so a
  --     widening cannot retire it silently.
  v_ok := false;
  begin
    insert into public.value_signals
      (match_id, outcome, market, detected_odds, detected_edge,
       model_architecture, phase, result, signal_category)
    values (v_match, 'home', 'h2h', 2.00, 0.05, 'ELO', 'prematch', 'pending', 'value');
    raise exception 'PROBE_ACCEPTED';
  exception
    when check_violation then v_ok := true;
    when others then
      if sqlerrm = 'PROBE_ACCEPTED' then v_ok := false; else raise; end if;
  end;
  if not v_ok then
    raise exception '108 FAILED: ELO is now storable — see migration 088';
  end if;

  raise notice '108: the three in-play writers are storable; ELO is not.';
end $$;

-- ── 4. Assert the containment this migration relies on ─────────────────────
-- If any of the three ever gains `publish = true`, the RESTRICTIVE policy
-- starts serving its PENDING rows to every browser seat — which is a
-- publication decision, and one nobody has made. Fail here rather than let
-- this migration be the thing that quietly enabled it.
do $$
declare v_pub text;
begin
  select string_agg(model_architecture, ', ')
    into v_pub
  from public.model_calibration
  where publish
    and model_architecture = any (array['INPLAY_DIXON_COLES','SECOND_HALF_SNIPER','SUPERMODEL_HALFTIME']);
  if v_pub is not null then
    raise exception '108 REFUSED: % has publish=true — storable would mean published', v_pub;
  end if;
  raise notice '108: none of the three publishes; pending rows stay behind the RESTRICTIVE policy.';
end $$;

commit;
