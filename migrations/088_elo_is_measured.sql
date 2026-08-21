-- 088_elo_is_measured.sql
--
-- ELO GETS A MEASURED SIGMA. It is the most-rendered forecast in the product —
-- a vector on 99.97% of upcoming fixtures, drawn on the match card, on
-- /signals and on every /competitions row — and it has had NO ROW in
-- `model_calibration` at all: the LAMBDA_MC shape. No sigma, so no score, so
-- no rung, and the match card says "no measured error bar" on every fixture.
--
-- WHERE THE NUMBER COMES FROM, AND WHY NOT FROM value_signals.
-- `calibration_report()` (migration 048) measures sigma from `value_signals` —
-- rows a model BET on. ELO has never written one; it writes `elo_forecasts`,
-- which is forward-looking and held 49 settled fixtures on 21 Aug 2026.
-- Calibrating the product's most-rendered forecast off fifty games would be the
-- failure this table exists to prevent, with a number attached to it.
--
-- `lib/disagreementFit.calibrationSigma()` is migration 048's estimator,
-- statement for statement, run over the research corpus that module already
-- replays — using the engine's OWN `updatePair`, `eloProbs` and the production
-- `goal_model_params`, so it measures the model that actually runs. It is
-- verified against the SQL rather than argued to match it: reconstructed from
-- `calibration_report()`'s own output it reproduces API_PREDICTIVE (n=281,
-- 0.0000) and LAMBDA_MC (n=166, 0.0751) exactly. See
-- engine.disagreementfit.test.js.
--
-- Measured 21 Aug 2026, `refreshDisagreement.js --sigma`, 38,787 selections in
-- ten bins:
--
--     sigma_p = 0.0502        2 sigma = 10.13pp, which is the PRIME bar
--
-- AND THE RELIABILITY CURVE IS THE FINDING, not the scalar. ELO is
-- systematically OVERCONFIDENT, monotonically across the range:
--
--     forecast   7.7%   realised 13.6%   miss  +5.9pp   n=  786
--     forecast  16.2%   realised 22.0%   miss  +5.8pp   n= 5107
--     forecast  24.6%   realised 27.2%   miss  +2.6pp   n=16388
--     forecast  35.0%   realised 35.7%   miss  +0.7pp   n= 5078
--     forecast  44.9%   realised 41.0%   miss  -3.9pp   n= 4547
--     forecast  54.8%   realised 47.2%   miss  -7.5pp   n= 3702
--     forecast  64.4%   realised 52.8%   miss -11.6pp   n= 2131
--     forecast  74.2%   realised 64.3%   miss  -9.8pp   n=  855
--     forecast  83.4%   realised 70.4%   miss -13.0pp   n=  186
--
-- It underrates longshots and badly overrates favourites. That is the classic
-- uncalibrated-Elo signature and it is exactly where the big disagreements come
-- from — so the rows that would score highest are the rows this curve says to
-- trust least.
--
-- TWO INDEPENDENT MEASUREMENTS AGREE, WHICH IS THE PART WORTH KEEPING.
-- `disagreement_calibration.min_publishable_gap` for ELO is 0.10, set from the
-- count-versus-Brier contradiction and nothing else. The 2-sigma PRIME bar
-- computes to 10.13pp from the reliability curve and nothing else. Two
-- different quantities, measured two different ways, landing 0.13pp apart.
--
-- publish = FALSE, AND THAT IS NOT A FORMALITY. Calibrating is not publishing.
-- Across every band there is, ELO loses Brier to the market — 0.1927 vs 0.1924
-- under 3pp, 0.2696 vs 0.2204 above 15pp — and at 15pp+ the market finishes
-- closer 59.8% of the time. A measured error bar is a fact about the forecast;
-- whether its output may be presented as a BACKED SELECTION is a separate
-- ruling that `lib/publication.ts` owns and that fails closed on a name it has
-- not heard of. Flipping this boolean cannot publish anything.
--
-- IT ALSO CANNOT PRODUCE A SIGNAL, AND THAT GUARD IS LEFT STANDING.
-- `value_signals_model_architecture_check` does not admit 'ELO'. So this row
-- gives ELO a measured sigma and changes nothing about what the product backs:
-- letting ELO write signals is the product starting to back ELO selections,
-- which is a much larger ruling than a calibration. The constraint is
-- deliberately NOT loosened here.
--
-- WHAT IT DOES CHANGE, TODAY. `/api/match-card` reads sigma from this table and
-- draws a band only when `sigma_source = 'measured'`; `ModelVsMarket` already
-- has the three branches written. So the match card stops saying "no measured
-- error bar" and draws a real one, with no application change at all.
--
-- WHAT IS DELIBERATELY NOT TOUCHED
--
-- DIXON_COLES measured 0.0147 on this corpus against a stored floor of 0.0300 —
-- half the bar — and it is NOT changed, because the corpus is not that model.
-- `research_dc_preds` is a historical Dixon-Coles 1X2 fit on English data;
-- production DIXON_COLES writes totals and BTTS and its h2h output inverts the
-- market's own de-vigged price. Same name, different model, and transferring a
-- sigma between them would halve a publishing architecture's PRIME bar on the
-- strength of a measurement of something else.
--
-- The ELO transfer is legitimate for exactly the reason that one is not: the
-- replay runs the engine's own rating update and its own 1X2 vector with the
-- production parameters. It is the model that ships.
--
-- MARKET_ANCHORED measured 0.0000 over 44,820 — its "model side" is Pinnacle's
-- own de-vig, and a sharp book's de-vigged line is genuinely well calibrated.
-- Its 0.0300 is therefore a pure resolution floor and is left alone.
--
-- Reversible: delete from public.model_calibration where model_architecture = 'ELO';

begin;

insert into public.model_calibration
  (model_architecture, sigma_p, sigma_source, z_gate, n_settled, publish, notes, calibrated_at)
values (
  'ELO',
  0.0502,
  'measured',
  1.0,
  38787,
  false,
  'Measured 21 Aug 2026 by lib/disagreementFit.calibrationSigma() over 38,787 '
  || 'research-corpus selections in 10 bins — migration 048''s estimator, run on '
  || 'the Elo replay that uses the engine''s own updatePair/eloProbs and the '
  || 'production goal_model_params. n_settled counts RESEARCH SELECTIONS, not '
  || 'live settled bets: ELO writes no value_signals and '
  || 'value_signals_model_architecture_check does not admit it. '
  || 'SYSTEMATICALLY OVERCONFIDENT: +5.9pp at a 7.7% forecast, -11.6pp at 64.4%, '
  || '-13.0pp at 83.4% — it underrates longshots and overrates favourites, which '
  || 'is where its widest disagreements come from. 2 sigma = 10.13pp, within '
  || '0.13pp of the 10pp min_publishable_gap disagreement_calibration set '
  || 'independently from the count-vs-Brier crossover. publish=false: it loses '
  || 'Brier to the market in every band (0.2696 vs 0.2204 above 15pp) and the '
  || 'market finishes closer 59.8% of the time there.',
  now()
)
on conflict (model_architecture) do update
  set sigma_p       = excluded.sigma_p,
      sigma_source  = excluded.sigma_source,
      z_gate        = excluded.z_gate,
      n_settled     = excluded.n_settled,
      notes         = excluded.notes,
      calibrated_at = excluded.calibrated_at;
      -- `publish` is deliberately NOT in the update list. A re-measurement must
      -- never be able to change a publication ruling as a side effect; that is
      -- the standing rule this file's header restates.

-- ── Assertions, before this commits ─────────────────────────────────────────
do $$
declare v record; v_admits boolean;
begin
  select * into v from public.model_calibration where model_architecture = 'ELO';
  if v is null then raise exception '088 FAILED: no ELO row'; end if;
  if v.sigma_source <> 'measured' then
    raise exception '088 FAILED: ELO sigma_source is %, not measured', v.sigma_source;
  end if;
  if v.publish then raise exception '088 FAILED: ELO must not publish'; end if;

  -- The two architectures that DO publish must be untouched by this migration.
  if (select sigma_p from public.model_calibration where model_architecture = 'DIXON_COLES') <> 0.0300
     or (select sigma_p from public.model_calibration where model_architecture = 'MARKET_ANCHORED') <> 0.0300 then
    raise exception '088 FAILED: a publishing architecture''s sigma moved';
  end if;

  -- And ELO still cannot write a signal. If this ever passes, someone has
  -- loosened the check constraint and the note above has gone stale.
  begin
    perform 1 from public.value_signals where false;
    select true into v_admits;
  exception when others then v_admits := false;
  end;
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.value_signals'::regclass
      and conname = 'value_signals_model_architecture_check'
      and pg_get_constraintdef(oid) like '%''ELO''%'
  ) then
    raise exception '088 FAILED: value_signals now admits ELO — this migration '
      'asserts it does not, and the header explains why that guard stands';
  end if;
end $$;

commit;
