-- 072_goal_model_params.sql
--
-- CALIBRATION PARAMETERS ARE DATA, NOT CONSTANTS.
--
-- The sigma constants are the cautionary tale this table exists to avoid. A
-- number that was measured once and then hand-copied into a source file
-- disagrees with the table it mirrors the moment either moves, and neither
-- copy throws when it does — eve-frontend shipped a null score for the one
-- enabled architecture on 6 Aug and scored the board against the wrong
-- architecture's sigma on 7 Aug, both from exactly that. So every parameter
-- fitted against outcomes lands here first, with the corpus it was fitted on,
-- the n, and the interval; code reads the table.
--
-- WHAT IS IN IT (MXDC_V1, fitted 19 Aug 2026)
--
--   rho              -0.061   Dixon-Coles low-score correlation
--   theta            +0.006   Gaussian dispersion tilt on the total, exp(-theta*(k - lambda_T)^2)
--   max_goals        12       score-matrix truncation
--
-- rho was fitted by maximum likelihood against REALISED GOALS ONLY — 38,023
-- fixtures across nine leagues and 21 seasons, with lambda from a leave-one-out
-- shrunk attack/defence estimate and no market input at any point. It is not
-- fitted to agree with a price, and must never be: a rho chosen to minimise
-- disagreement with the market makes the model restate the price and destroys
-- the only thing it could have been for.
--
-- The tau correction is EXACTLY normalised — the four cell adjustments times
-- their Poisson products cancel to zero for any rho — so the rho likelihood is
-- closed-form over the four low-score cells alone and needs no normalising
-- constant. See docs/MXDC_V1_CALIBRATION.md for the derivation and the fit.
--
-- rho = -0.061 REPLACES NOTHING YET. lib/dixonColes.js still declares
-- DEFAULT_RHO = -0.13 (Dixon-Coles 1997, English league, 1992-95) and that
-- default is live in lib/secondaryMarkets.js and lib/lambdaBoard.js. The
-- measured value is decisively different — the 1997 figure sits 53.7
-- log-likelihood units below the peak, and every era and every big-five league
-- in this corpus lands between -0.03 and -0.105 — but changing a live pricing
-- default is a separate, deliberate change with its own verification, not a
-- side effect of a research migration. This table records what was measured.
--
-- theta is a dispersion correction and it goes the OTHER WAY from the
-- expectation. Conditional on lambda, total goals are UNDER-dispersed relative
-- to Poisson by about 3.6% in variance, not over-dispersed; the familiar
-- over-dispersion is a property of the UNCONDITIONAL distribution and is
-- entirely lambda heterogeneity. theta is significant (t 3.2) and worth 4.9
-- log-likelihood units over 14,925 fixtures, which is 0.0003 per fixture, and
-- it moves P(over 2.5) by 0.16pp on average because the 2.5 line sits at the
-- centre of the distribution where a variance tilt has almost no leverage. It
-- would matter at 0.5, 1.5, 4.5 and 5.5.

create table if not exists goal_model_params (
  model            text        not null,
  version          text        not null,
  param            text        not null,
  value            double precision not null,
  ci_lo            double precision,
  ci_hi            double precision,
  corpus           text        not null,
  n_fixtures       integer     not null,
  method           text        not null,
  fitted_at        timestamptz not null default now(),
  notes            text,
  primary key (model, version, param)
);

comment on table goal_model_params is
  'Goal-model parameters fitted against realised outcomes. Code reads this table; it does not hard-code the numbers. Never fit any row here to minimise disagreement with a market price.';

alter table goal_model_params enable row level security;

-- Read-only from the client, like model_calibration. No client write path:
-- migration 07x-era policy is that anon holds zero write privileges anywhere.
drop policy if exists goal_model_params_read on goal_model_params;
create policy goal_model_params_read on goal_model_params for select to anon, authenticated using (true);
revoke insert, update, delete, truncate on goal_model_params from anon, authenticated;

insert into goal_model_params (model, version, param, value, ci_lo, ci_hi, corpus, n_fixtures, method, notes) values
  ('MXDC_V1','v1','rho', -0.061, -0.074, -0.048,
   'matches: realised goals, 9 leagues, 21 seasons, 2005-2026, leave-one-out shrunk lambda (K=15), no market input',
   38023,
   'maximum likelihood over the four Dixon-Coles low-score cells; tau is exactly normalised so no normalising constant is needed',
   'Beats rho=0 by 42.2 loglik units (LR chi2 84) and the 1997 default -0.13 by 53.7. A single global rho is not rejected against per-league rho (delta 9.75 on 8 df, p 0.28) nor against per-era (1.43 on 2 df, p 0.49). Residual low-cell chi2 is still 26 on 3 df: the tau shape is directionally right and not the whole story.'),
  ('MXDC_V1','v1','theta', 0.006, 0.002, 0.011,
   'research_dc_preds: realised goals against lambda inverted from Shin-de-vigged Pinnacle closing 1X2, 5 English divisions, 2019-2026',
   14925,
   'maximum likelihood of the realised total under P''(T=k) proportional to P(T=k)*exp(-theta*(k-lambda_T)^2)',
   'MLE is 0.0065 +/- 0.0021 (t 3.2); 0.006 is the grid value every downstream number below was measured at. Conditional UNDER-dispersion, not over-dispersion: model conditional Var(T) 2.640 -> 2.546, about -3.6%. Corroborated independently on the matches corpus (-3.5%). Worth 4.9 loglik over 14,925 fixtures; moves P(over 2.5) by 0.16pp and makes the over/under 2.5 log-loss very slightly worse. Apply it at outer lines, not at 2.5.'),
  ('MXDC_V1','v1','max_goals', 12, null, null,
   'numerical, not fitted', 0,
   'score-matrix truncation',
   'Truncating at 10 instead of 12 moves P(over 2.5) by at most 4e-5 across the live lambda range. 12 is free.')
on conflict (model, version, param) do update
  set value = excluded.value, ci_lo = excluded.ci_lo, ci_hi = excluded.ci_hi,
      corpus = excluded.corpus, n_fixtures = excluded.n_fixtures,
      method = excluded.method, notes = excluded.notes, fitted_at = now();

-- The paper-model row. STATUS IS 'failed', AND THAT IS THE FINDING, NOT A
-- PLACEHOLDER. MXDC_V1's whole premise is that a book's own 1X2 prices imply a
-- total it is not quoting. Measured over 14,925 fixtures of Pinnacle closing
-- prices, the residual between the two carries no information about the
-- outcome: regressing (realised over-2.5 minus the market's own de-vigged
-- probability) on that residual gives slope 0.093 +/- 0.123, where real signal
-- would give 1. Full write-up in docs/MXDC_V1_CALIBRATION.md.
insert into paper_models (model, version, market, status, hypothesis, started_at, notes) values
  ('MXDC_V1','v1','totals','failed',
   'A book''s de-vigged 1X2 prices imply a total-goals distribution, and where its own over/under line disagrees with that implication the line is wrong.',
   now(),
   'Rho and dispersion calibrated to realised goals first (rho -0.061 on 38,023 fixtures; conditional under-dispersion theta +0.006). Residual vs Pinnacle closing over/under 2.5, 14,925 fixtures: mean -0.74pp, mean abs 2.63pp, sd 3.30pp. Slope of (outcome - market) on residual 0.093 +/- 0.123, t 0.76, 95% CI upper 0.33 — signal would be 1. Unchanged at 0.088 +/- 0.150 after removing the systematic favourite-strength and totals-line components. Positive control on the same pipeline: Pinnacle minus book-average predicts at slope 1.50 +/- 0.48, t 3.12, on a residual four times SMALLER, so this is not a power failure. Model is behind the market it would bet into on log-loss (0.6829 vs 0.6810) and Brier (0.2449 vs 0.2440). Economically, on a bettable two-book closing panel (overround 1.0343): EV>=+2% selects 5,812 bets claiming +5.86% and realising -0.66% (z -0.52); EV>=+5% claims +8.64% and realises +0.50% (z 0.27); at EV>=0 realised ROI is -2.61% (z -2.57). Restricted to fixtures where the market anchor sees NO edge — the model''s own contribution — 5,702 bets return -0.80%.')
on conflict (model) do update
  set version = excluded.version, market = excluded.market, status = excluded.status,
      hypothesis = excluded.hypothesis, notes = excluded.notes;
