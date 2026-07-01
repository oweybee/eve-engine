-- 032_inplay_baseline.sql
-- =============================================================================
-- Pre-match goal-expectation baseline for the in-play win-probability engine
-- (lib/inplayWinProb.js). captureBaseline.js freezes, per match near kickoff,
-- the full-match (λ_home, λ_away) implied by the de-vigged consensus 1X2.
-- computeInplayValues.js then holds liveWinProb(λ, current score, minute) against
-- the live price. Competition-agnostic — this is what serves internationals.
--
-- One row per match; refreshed toward the closing line while pre-kickoff, then
-- left frozen once the match starts (the pre-match view is the anchor).
-- =============================================================================

CREATE TABLE IF NOT EXISTS inplay_baseline (
  match_id     UUID PRIMARY KEY REFERENCES matches(id),
  lambda_home  NUMERIC NOT NULL,
  lambda_away  NUMERIC NOT NULL,
  p_home       NUMERIC,          -- de-vigged consensus probs the λ were fit to
  p_draw       NUMERIC,
  p_away       NUMERIC,
  source       TEXT DEFAULT 'consensus',
  captured_at  TIMESTAMPTZ DEFAULT now()
);

-- Register the win-prob architecture (preserving the set from migration 030).
ALTER TABLE value_signals DROP CONSTRAINT IF EXISTS value_signals_model_architecture_check;
ALTER TABLE value_signals ADD CONSTRAINT value_signals_model_architecture_check
  CHECK (model_architecture IS NULL OR model_architecture = ANY (ARRAY[
    'MARKET_CONSENSUS'::text,
    'API_PREDICTIVE'::text,
    'DIXON_COLES'::text,
    'CORNERS_MODEL'::text,
    'CARDS_MODEL'::text,
    'ML_ENSEMBLE'::text,
    'XGBOOST_PREMATCH'::text,
    'SUPERMODEL_PREMATCH'::text,
    'SUPERMODEL_HALFTIME'::text,
    'INPLAY_DIXON_COLES'::text
  ]));

COMMENT ON TABLE inplay_baseline IS
  'Frozen pre-match (λ_home, λ_away) per match; anchor for the in-play '
  'win-probability engine. Refreshed until kickoff, then held constant.';
